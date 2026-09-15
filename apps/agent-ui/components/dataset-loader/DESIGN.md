# dataset-loader 组件设计文档

## 定位

暴露 worker 机器上已存在的 CSV/Parquet 文件。验证路径存在、自动检测格式，
输出标准文件卡片供下游消费。**不下载、不复制、不加载数据** — 纯路径校验 + 格式探测。

## 契约

### 输入端口

无（源节点）。

### 输出端口

| 端口 | 类型 | 说明 |
|------|------|------|
| `outputFile` | file | config.file 指定的原始文件，原样透传 |

#### 输出数据 schema

本组件不处理数据内容，输出文件即 `config.file` 指定的原始文件，schema 由该文件自身决定。
例如用户填 `/mnt/data/stock_list.csv`，输出就是那个 CSV 文件的原样内容。

### 配置参数

| Key | Label | 类型 | 必填 | 说明 |
|-----|-------|------|------|------|
| `file` | 文件路径 | string | ✅ | worker 机器上的本地文件绝对路径。支持 `.csv` / `.csv.gz` / `.csv.zip` / `.parquet` / `.pq` / `.parq` |

## 核心流程

### Phase 1: 读取配置

从 `$AGENT_UI_INPUT_PATH` 读取输入 JSON，提取 `file` 字段。源节点的输入由引擎从
`node.config.params` 直接注入，内容即用户在属性面板填写的配置参数。

### Phase 2: 路径校验

1. `os.path.abspath(file)` 转绝对路径
2. `os.path.isfile(path)` 检查文件存在且是普通文件（目录、不存在均失败）

### Phase 3: 格式检测

按扩展名匹配：

| 扩展名 | format 值 |
|--------|-----------|
| `.csv` / `.csv.gz` / `.csv.zip` | `csv` |
| `.parquet` / `.pq` / `.parq` | `parquet` |

未知扩展名 → 直接失败（不产出 unknown 格式）。

### Phase 4: 输出

写入 `$AGENT_UI_OUTPUT_PATH`：

```json
{"outputFile": {"path": "<absolute path>", "format": "<csv|parquet>"}}
```

下游节点从 `outputFile.path` 读取文件，自行解析内容（通常是 `pd.read_csv()` 或
`pd.read_parquet()`）。

## 注册信息

- **Entry Point**: `apps/agent-ui/components/dataset-loader/run.py`
- **Git URL**: `git@github.com:hy2014/astromere-agent.git`
- **Git Branch**: `dev`
- **全局组件**: ✅
- **configSchema**:

  ```json
  [
    {
      "key": "file",
      "label": "文件路径",
      "type": "string",
      "required": true,
      "description": "worker 机器上的本地 CSV/Parquet 文件绝对路径"
    }
  ]
  ```
