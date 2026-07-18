# 并行执行与组件检出 redesign

> 设计文档。落地前先改 `docs/` 再改 `src/`。**§3 组件检出（不可变 per-commit）与 §2 并行总体（单 worker 进程 + 内部多线程调度器）均已实现并通过测试**：`runner.py::prepare_env` 重写 + `worker.py`（`compute_layers` / 层并发 `process` / `component_sem` / `main` 并发调度器 / `claim_next` 的 `exclude_dag_ids` per-DAG 互斥）+ `db.py`。未提交，待统一 review 后提交。

## 1. 背景与目标

当前引擎全程串行：单 worker、单 DAG、DAG 内节点 one-by-one。
目标：在**受控并发**下提升吞吐，同时消除「相同组件跨 DAG 并发 git pull」的竞态。

## 2. 并行执行模型（单 worker 进程 + 内部多线程调度器）

- **保持单 worker 进程**：`engine.rs` 仍只起 1 个 `worker.py`（崩溃由 Rust 重启，保留进程级隔离）。**不引入多 worker 进程**——跨进程协调（claim 互斥、全局信号量）需靠 SQLite 原子性或外部锁，存在 TOCTOU 竞态窗口且调试困难；经 review 废弃多进程方案，把所有协调收进单进程内。
- **worker.py 内部重构为并发调度器**：主 loop `claim_next` 取一个 `submit` 的 exec，提交给**进程内线程池**异步并发 `process` 多个 DAG run；主 loop 不阻塞，可继续 claim 下一个。
- **per-DAG 互斥（进程内）**：调度器维护 `running_dags: set`，同 `dag_id` 同时只跑 1 个 run（手动触发与 cron 触发的同 dag run 不交错）。`db.py::claim_next` 的 SQLite 乐观锁保留为防多实例双保险。
- **全局并发信号量（进程内）** `MAX_CONCURRENT_COMPONENTS = min(CPU, 8)`：用 `threading.Semaphore`，每个节点**真正起 Popen 前 `acquire()`、结束后 `release()`**，精确限流同时跑的组件子进程数。
- **DAG 内按拓扑层（layer）并发**：`process` 改为按拓扑层分组，同层节点用线程池并发；层间等待上一层完成（节点间 `node_outputs` / status 门控用进程内 dict + `Lock` 共享）。

> 并行度 = 进程内线程池并发的组件子进程数，主旋钮即 `MAX_CONCURRENT_COMPONENTS`。worker 进程数恒为 1，崩溃隔离由 Rust 侧负责，无需应用层多进程。

## 3. 组件环境检出 redesign：不可变 per-commit 检出

### 3.1 现状问题

`runner.py::prepare_env` 把组件克隆到 `cache_root/<hash>`，`hash = sha256(url@branch@ref)[:16]`。
同一组件跨 DAG（url+branch+ref 相同）→ **落到同一目录**。两个 worker 同时 `_resync_cached` 对同一目录 `git fetch` + `git reset --hard` → 工作树互相踩坏；首次克隆也因双 `git clone` 同目录而失败。

### 3.2 新方案：按 commit SHA 命名、不可变工作树

核心思想：把「一个会被反复 `reset --hard` 的可变目录」改为「按解析出的 commit SHA 命名的、创建后永不修改的目录」。

缓存布局：

```
cache_root/<key>/                 # key = sha256(url@branch@ref)[:16]，组件槽位
cache_root/<key>/<sha>/           # 不可变工作树，目录名即该次检出的真实 commit
cache_root/<key>/.resolve.lock    # 可选：合并同一瞬间的冗余 clone
```

`prepare_env` 重写流程：

1. 算 `key`。
2. 解析目标 `sha`：
   - 若 `git_ref` 是完整 40 位 hex commit → `sha = git_ref`；
   - 否则 `git ls-remote` 解析 branch/tag → `sha`（可选：把上次 sha 缓存到 `<key>/.last-sha`，未变则跳过 `ls-remote`）。
3. `target = cache_root/<key>/<sha>`。
4. 若 `target` 存在且含有效 marker → **直接复用，零 git 操作**（只读）。
5. 否则：
   - （可选）取 `<key>/.resolve.lock` 合并并发；
   - `git clone --depth 1 --branch <branch> <url> <tmp>`（独立临时目录）；
   - 若 `git_ref` 非 branch 尖端：`git checkout --force <git_ref>` + `git reset --hard <git_ref>`；
   - `sha = git -C <tmp> rev-parse HEAD`（以实际检出 commit 为准，保证目录名=真实 commit）；
   - `os.rename(<tmp>, target)`；若 `target` 已存在（另一 worker 先 promote）→ 丢弃 `<tmp>`，复用现有 `target`；
   - 释放锁。
6. 返回 `target`（即 `AGENT_UI_COMPONENT_ROOT`）。

### 3.3 为什么 git 并发竞态消失

- **并发 clone 到不同临时目录**：git clone 对独立目录安全，无共享可变状态。
- **promote 原子**：`os.rename` 到 `<sha>` 目录，目标存在则失败并回退复用——无需锁即正确。
- **工作树永不 reset**：`<sha>` 创建后只读，并发跑同一 commit 互不干扰。
- **同一 commit 重跑零 git 开销**：第 4 步直接复用，连 `ls-remote` 都可跳过。
- **remote 在两次 clone 间移动**：两 worker 解析出不同 sha → 不同目录 → 各自 pin 到自己解析到的 commit，无损坏。
- 可选的 `.resolve.lock` 仅用于**合并同一瞬间的冗余 clone**（少打一次网络），正确性不依赖它。

### 3.4 与并行执行模型的关系

- 与 per-DAG 互斥**正交**：per-DAG 互斥管「同 dag 的不同 run 不交错」；per-commit 原子 promote 管「不同 DAG 共享组件克隆目录时不损坏 git」。两者叠加。
- 即使保留串行 git 同步，也只在「冷启动或 remote 真更新」那一瞬发生；运行期各组件 Python 子进程在各自 `work_dir`（已实现按节点隔离）并行，不阻塞。

### 3.5 关联：pip install 并发

当前 `prepare_env` 不做 pip（在别处按解析出的解释器安装）。不可变 per-commit 目录天然为依赖安装提供隔离锚点：每个 `<sha>` 目录可持有自己的 `.venv`/依赖，跨 run 的 pip 安装互不踩。具体落地见并行执行总体方案，本 redesign 预留该扩展点（返回 `target` 即依赖隔离边界）。

## 4. 默认值

| 旋钮 | 默认 | 说明 |
|---|---|---|
| `MAX_CONCURRENT_COMPONENTS`（全局最大并发组件子进程数，进程内 `Semaphore`） | `min(CPU, 8)` | 唯一真正限流的旋钮，跨所有 DAG run / 节点 |
| 调度器线程池大小 | `min(CPU, 8)` | 并发 `process` 的 DAG run 数上限（实际受信号量约束不会超 MAX） |
| 层内节点并发 | 受全局信号量约束，不单独设固定值 | — |
| worker 进程数 | 1（不变） | 多进程方案已废弃，锁全部收进单进程 |

## 5. 实施步骤

### §3 组件检出（已完成）

1. ✅ 重写 `engine_executor/runner.py::prepare_env`：key→槽位目录、`ls-remote` 解析 sha、tmp clone + 原子 promote、只读复用（已过 6 单测）。
2. ✅ 保留 `_looks_like_local` 直用本地目录的短路路径（不变）。
3. ✅ `worker.py` 调用点基本不变（`AGENT_UI_COMPONENT_ROOT` 仍指向返回目录，只是现在是 `<sha>` 子目录）。
4. ✅ 补单测：同 key 并发 `prepare_env` 不损坏、同 sha 复用、不同 sha 隔离。

### §2 并行总体（单 worker 进程 + 内部多线程，待实施）

5. **worker.py 重构为并发调度器**：主 loop `claim_next` → 提交进程内线程池异步 `process` 多个 DAG run；`running_dags` set 实现 per-DAG 互斥（同 dag 同时只 1 个 run）。
6. **全局信号量（进程内）**：`threading.Semaphore(min(CPU,8))`，`run_node` 起 Popen 前 `acquire`、结束后 `release`。
7. **`process` 改拓扑层并发**：按 layer 分组，同层线程池并发；`node_outputs`/`node_status` 加 `Lock`；层间 join；分支隔离语义（failed→下游 skipped）保持。
8. **`db.py::claim_next` 保留 SQLite 乐观锁**（防多实例双保险），`engine.rs` 不变（仍单 worker 进程）。
9. 单测：per-DAG 互斥（同 dag 两 run 不交错）、层并发正确性、信号量限流、取消传播。

## 6. 风险 / 待确认

- Windows 下 `os.rename` 覆盖非空目录行为差异 → 用存在性检查 + 删 tmp 兜底。
- `git ls-remote` 对私有仓库的鉴权沿用现有 git 配置。
- 磁盘增长：每个 commit 一个目录，需定期 GC（按 `<key>/.last-sha` 保留最近 N 个，其余清理）——列为后续项。
- 单进程多线程下，worker 进程崩溃会中断所有在跑 run；但 `try/except` 已兜底单节点异常，且 Rust 会重启 worker（重启后从 DB 恢复 `submit` 状态）。多进程崩溃隔离的优势在本方案下让位于协调简单性，经 review 接受。
