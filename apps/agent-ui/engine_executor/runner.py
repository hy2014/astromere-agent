"""Component environment preparation and execution.

Responsibilities (matching the agreed engine_executor scope):
  * prepare the environment (git clone, cached by git url+branch)
  * resolve the python interpreter (explicit path or auto-detect, no venv)
  * ensure dependencies: check requirements.txt, pip install only the missing
    ones (with live logs + a mirror), never blindly reinstall everything
  * run the component's entry point
  * stream stdout/stderr back to the caller (which persists them as logs)

The worker owns the state machine; this module is the "do the work" primitive.
"""

import hashlib
import json
import os
import shutil
import signal
import subprocess
import threading
import time


def _git(root, args):
    """Run a git subcommand inside ``root``; raise RuntimeError on failure."""
    r = subprocess.run(["git", "-C", root, *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or f"git {' '.join(args)} failed")
    return r


def _cache_key(git_url: str, branch: str, git_ref: str = "") -> str:
    return hashlib.sha256(f"{git_url}@{branch}@{git_ref}".encode()).hexdigest()[:16]


def _looks_like_local(path: str) -> bool:
    """Return True only if the path must be used *directly*, with no git clone.

    A genuine git URL — including the local ``file://`` transport — is NOT
    treated as local: it flows into the clone branch so the component is
    fetched through the same ``git clone`` path as a remote repository.
    Plain filesystem paths (absolute/relative/existing dirs) are used as-is.
    """
    if not path:
        return False
    if path.startswith(("/", "./", "../")):
        return True
    return os.path.isdir(path)


def _pin_ref(root, branch, git_ref):
    """Check out a specific commit/tag/branch inside an already-cloned repo.

    ``git_ref`` may be a branch name, a tag name, or (with a full/deep clone) a
    raw commit sha. We fetch it explicitly so it lands as a real ref, then
    check out + hard-reset the working tree to it.
    """
    target = None
    # 1) branch -> create the remote-tracking ref origin/<ref>
    try:
        _git(root, ["fetch", "--depth", "1", "origin", f"{git_ref}:refs/remotes/origin/{git_ref}"])
        target = f"origin/{git_ref}"
    except RuntimeError:
        pass
    # 2) tag -> creates a local refs/tags/<ref>
    if target is None:
        try:
            _git(root, ["fetch", "--depth", "1", "origin", "tag", git_ref])
            target = git_ref
        except RuntimeError:
            pass
    # 3) raw sha (or anything else) -> fetch the branch so the object exists
    if target is None:
        _git(root, ["fetch", "--depth", "1", "origin", f"{branch}:refs/remotes/origin/{branch}"])
        target = git_ref
    _git(root, ["checkout", "--force", target])
    _git(root, ["reset", "--hard", target])


def _resync_cached(root, branch, git_ref, log):
    """Update an existing clone so a freshly pushed commit is picked up.

    If the requested ``branch`` does not exist on the remote, this raises a
    ``RuntimeError`` — it must NOT silently fall back to another branch, or
    the executor would run code the user never asked for.
    """
    if git_ref:
        log("info", f"prepare_env: cache exists; pinning to ref {git_ref}")
        _pin_ref(root, branch, git_ref)
        return
    log("info", f"prepare_env: cache exists; re-pulling origin/{branch}")
    _git(root, ["fetch", "--depth", "1", "origin", branch])
    _git(root, ["reset", "--hard", f"origin/{branch}"])
    log("info", f"prepare_env: sync complete in {root}")


def prepare_env(git_url, git_branch, cache_root, git_ref="", log_fn=None):
    """Resolve a component root directory by cloning/syncing the component's

    * A git URL (``https://``, ``git@``, or the local ``file:///abs/path``
      transport) is cloned into ``cache_root/<hash>``. The **same**
      ``(git_url, branch, git_ref)`` always resolves to the same directory
      (the cache key), so a re-run reuses the clone — but it is **re-synced
      first** so a freshly pushed commit is picked up. This is what makes
      "edit code → push → run dag" work: the executor never runs stale code.
      ``file://`` goes through the exact same ``git clone`` path as a remote.
    * ``git_ref`` (optional) pins the clone to a specific commit/tag/branch.
      When set it is folded into the cache key (a different ref ⇒ a different
      directory) and the working tree is checked out to it after every sync,
      so the exact code that ran is reproducible and auditable.
    * A plain local directory (absolute/relative path, or an existing dir that
      is not a git URL) is used directly — no clone, no sync. This is the
      dev-time shortcut for pointing at an already-checked-out component.

    ``log_fn(kind, message)`` (kind in {"stdout","stderr","info","error"}) is
    invoked during sync so callers can surface "code changed / re-pulled"
    events in the run logs.
    """
    def log(kind, msg):
        if log_fn:
            log_fn(kind, msg)

    if git_url and _looks_like_local(git_url):
        local = git_url[7:] if git_url.startswith("file:") else git_url
        if os.path.isdir(local):
            log("info", f"使用本地目录（免克隆）: {local}")
            return local

    branch = git_branch or "master"
    key = _cache_key(git_url or "", branch, git_ref or "")
    root = os.path.join(cache_root, key)
    marker = os.path.join(root, ".claw-fetched")
    if os.path.isdir(root) and os.path.exists(marker):
        # Clone already exists for this exact (url, branch, ref): re-sync first
        # so new commits are picked up, then reuse the directory. A missing
        # branch must raise — never silently fall back to another branch.
        _resync_cached(root, branch, git_ref or "", log)
        return root

    os.makedirs(root, exist_ok=True)
    # Clone the explicitly requested branch. If it does not exist, fail loudly
    # instead of silently fetching the default branch.
    log("info", f"首次克隆组件: {git_url}@{branch} → {root}")
    r = subprocess.run(
        ["git", "clone", "--depth", "1", "--branch", branch, git_url, root],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        log("error", f"git clone 失败: {r.stderr.strip()}")
        raise RuntimeError(
            f"git clone failed: requested branch '{branch}' not found "
            f"(or clone error): {r.stderr.strip()}"
        )
    log("info", f"克隆完成: {root}")
    if git_ref:
        try:
            _pin_ref(root, branch, git_ref)
        except RuntimeError as e:
            raise RuntimeError(f"git checkout ref '{git_ref}' failed: {e}")
    open(marker, "w").close()
    return root


def _pip_index_url():
    """Mirror used for component installs.

    Defaults to a fast domestic mirror (Tsinghua) so installs aren't bottlenecked
    on the foreign pypi.org. Override with ``AGENT_UI_PIP_INDEX_URL`` (e.g. set
    to ``https://pypi.org/simple`` to use the default source).
    """
    return os.environ.get("AGENT_UI_PIP_INDEX_URL") or "https://pypi.tuna.tsinghua.edu.cn/simple"


def _ensure_pip_mirror(py, log_fn=None):
    """Write the chosen mirror into pip's GLOBAL config so every subsequent
    install (and the resolved interpreter's own pip) uses it. Idempotent;
    best-effort."""
    url = _pip_index_url()
    if not url:
        return
    try:
        subprocess.run(
            [py, "-m", "pip", "config", "set", "global.index-url", url],
            check=True,
            capture_output=True,
            text=True,
        )
        if log_fn:
            log_fn("info", f"已写入全局 pip 镜像源: {url}")
    except Exception as e:  # noqa: BLE001 - best effort; fall back to default source
        if log_fn:
            log_fn("warning", f"写入 pip 镜像源失败（将使用默认源）: {e}")


def _run_pip_install(target, req, log_fn=None, timeout=1800):
    """Run ``pip install -r req`` for ``target`` python, streaming every line to
    ``log_fn`` so the run panel shows live progress. Times out instead of hanging
    forever on a stuck network."""
    proc = subprocess.Popen(
        [target, "-m", "pip", "install", "-r", req],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    def reader(stream, kind):
        for line in stream:
            if log_fn:
                log_fn(kind, line.rstrip("\n"))

    t_out = threading.Thread(target=reader, args=(proc.stdout, "stdout"), daemon=True)
    t_err = threading.Thread(target=reader, args=(proc.stderr, "stderr"), daemon=True)
    t_out.start()
    t_err.start()
    try:
        rc = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        t_out.join()
        t_err.join()
        raise RuntimeError(
            f"pip install 超时（>{timeout}s）。可配置 AGENT_UI_PIP_INDEX_URL 指向更快的镜像源后重试。"
        )
    t_out.join()
    t_err.join()
    if rc != 0:
        raise RuntimeError("pip install 失败（详见上方日志）")


def _requirements_satisfied(py, req, log_fn=None):
    """Return True if every requirement in ``req`` is already satisfied by
    ``py``. Uses ``pip install --dry-run`` so nothing is installed here; if pip
    reports it *would* install/download something, the requirements are NOT fully
    satisfied. Falls back to "not satisfied" (do the real install) when --dry-run
    is unsupported or errors, so a genuinely missing dependency still gets
    installed."""
    try:
        proc = subprocess.run(
            [py, "-m", "pip", "install", "--dry-run", "-r", req],
            capture_output=True,
            text=True,
            timeout=300,
        )
    except Exception as e:  # noqa: BLE001 - can't be sure deps are satisfied
        if log_fn:
            log_fn("warning", f"依赖预检失败（将直接尝试安装）: {e}")
        return False
    out = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        if log_fn:
            log_fn("warning", "依赖预检不可用（pip --dry-run 失败），将执行安装")
        return False
    return not (("Would install" in out) or ("Would download" in out))


def _ensure_requirements(py, component_root, log_fn=None):
    """If the component ships a non-empty requirements.txt, verify its packages
    are present in ``py``; run ``pip install -r requirements.txt`` only when
    something is missing (with live logs + a mirror configured globally)."""
    req = os.path.join(component_root, "requirements.txt")
    if not (os.path.exists(req) and os.path.getsize(req) > 0):
        return  # no declared deps; nothing to do
    if _requirements_satisfied(py, req, log_fn):
        if log_fn:
            log_fn("info", "依赖已满足（requirements.txt 中的包均已安装），跳过 pip install")
        return
    _ensure_pip_mirror(py, log_fn)
    if log_fn:
        log_fn("info", "开始安装缺失依赖: pip install -r requirements.txt")
    _run_pip_install(py, req, log_fn)


def _python_version(py):
    """Return ``(major, minor)`` of ``py`` or ``None`` if it can't be queried."""
    try:
        out = subprocess.run(
            [py, "-c", "import sys; print(sys.version_info[:2])"],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except Exception:  # noqa: BLE001 - any failure => unknown version
        return None
    if out.returncode != 0:
        return None
    try:
        parts = out.stdout.strip().strip("()").split(",")
        return (int(parts[0]), int(parts[1].strip()))
    except Exception:  # noqa: BLE001 - unparsable version string
        return None


def _detect_python(log_fn=None):
    """Auto-detect a usable python interpreter — without assuming any specific
    server layout.

    Candidates are built dynamically (order = search priority):
      * ``python3.10`` and ``python3`` as resolved on ``PATH`` — i.e. whatever
        interpreter the worker process itself runs in / is first on PATH;
      * generic conda / anaconda base prefixes (``~/miniconda3``,
        ``~/anaconda3``, ``/opt/conda``, ``/opt/miniconda3``,
        ``/usr/local/miniconda3``) — each is *probed*, never assumed to exist,
        and its ``bin/python3.10`` / ``bin/python3`` (and on Windows
        ``Scripts/python.exe``) are added only if the base directory is there.

    Among the interpreters that genuinely exist and are executable, we prefer a
    CPython 3.10.x (the version components were validated against), then any 3.x,
    then anything at all. Returns the absolute path, or raises ``RuntimeError``
    if nothing usable is found.
    """
    candidates = []

    if log_fn:
        log_fn("info", "未配置 system.python_path，开始自动探测 Python 解释器"
                        "（搜索 PATH 与常见 conda/anaconda 基目录，优先 CPython 3.10）")

    # 1) PATH lookups — zero assumptions about where conda lives.
    for name in ("python3.10", "python3"):
        p = shutil.which(name)
        if p:
            if log_fn:
                log_fn("info", f"PATH 探测 {name} → {p}")
            candidates.append(p)
        elif log_fn:
            log_fn("info", f"PATH 未找到 {name}")

    # 2) Probe generic conda/anaconda base dirs. Only the ones that actually
    #    exist contribute candidates; we never hardcode a single machine path.
    bases = [
        os.path.expanduser("~/miniconda3"),
        os.path.expanduser("~/anaconda3"),
        "/opt/conda",
        "/opt/miniconda3",
        "/usr/local/miniconda3",
    ]
    for base in bases:
        if not os.path.isdir(base):
            continue  # 基目录不存在则跳过，不写入日志噪音
        if log_fn:
            log_fn("info", f"检测到 conda/anaconda 基目录: {base}")
        for sub in ("bin/python3.10", "bin/python3", "Scripts/python.exe", "python3.exe"):
            candidates.append(os.path.join(base, sub))

    # De-duplicate while preserving search order.
    seen, ordered = set(), []
    for c in candidates:
        if c not in seen:
            seen.add(c)
            ordered.append(c)

    found = []
    for cand in ordered:
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            ver = _python_version(cand)
            ver_str = ".".join(str(v) for v in ver) if ver else "未知版本"
            if log_fn:
                log_fn("info", f"候选可用: {cand}（Python {ver_str}）")
            found.append((cand, ver))

    if not found:
        if log_fn:
            log_fn("warning",
                   "自动探测未找到任何可用的 Python 解释器（已搜索 PATH 与常见 "
                   "conda/anaconda 基目录）")
        raise RuntimeError(
            "未配置 system.python_path，且自动探测未找到可用的 Python 解释器"
            "（已搜索 PATH 与常见 conda/anaconda 基目录）。"
            "请在节点「系统配置」中设置 system.python_path 指向一个存在的解释器。"
        )

    # Prefer 3.10.x, then any 3.x, then anything; ties keep search order.
    def score(item):
        _cand, ver = item
        if ver and ver[0] == 3 and ver[1] == 10:
            return 0
        if ver and ver[0] == 3:
            return 1
        if ver:
            return 2
        return 3

    found.sort(key=score)
    chosen, ver = found[0]
    ver_str = ".".join(str(v) for v in ver) if ver else "未知版本"
    if log_fn:
        log_fn("info", f"未配置 system.python_path，自动探测到 Python 解释器: {chosen}（{ver_str}）")
    return chosen


def resolve_python(component_root, python_path=None, log_fn=None):
    """Return the python binary to run the component with.

    Behaviour:
      * ``python_path`` set → validate it exists and is executable, then use it
        directly. Never create a venv or install anything. Use this when the
        component relies on an environment that already has its dependencies
        (e.g. an internal package installed editable into a conda env). The
        value is the absolute path to the python executable (e.g.
        ``/root/miniconda3/bin/python3.10``).
      * ``python_path`` not set → auto-detect: search ``PATH`` and generic
        conda/anaconda base dirs for a usable interpreter, preferring CPython
        3.10.x, then any 3.x. No venv is ever created.
    """
    if python_path:
        if not (os.path.isfile(python_path) and os.access(python_path, os.X_OK)):
            raise RuntimeError(
                f"指定的 Python 解释器不存在或不可执行: {python_path}"
            )
        if log_fn:
            log_fn("info", f"使用指定 Python 解释器（跳过 venv）: {python_path}")
        return python_path
    return _detect_python(log_fn)


def run_node(
    component_root,
    entry_point,
    input_value,
    work_dir,
    cancel_check=None,
    poll=0.25,
    log_fn=None,
    python_path=None,
):
    """Execute a single component node.

    Returns a dict with success / cancelled / returncode / stdout / stderr /
    output_path / output_value. ``cancel_check`` is polled while the process
    runs; if it returns True the whole process group is terminated.

    ``log_fn(kind, message)`` (kind in {"stdout", "stderr"}) is invoked for
    every line as it is produced, so callers can persist logs in real time
    (the worker wires this to ``db.add_log`` so the UI sees live output).
    """
    os.makedirs(work_dir, exist_ok=True)
    input_path = os.path.join(work_dir, "input.json")
    output_path = os.path.join(work_dir, "output.json")
    with open(input_path, "w") as f:
        json.dump(input_value, f)
    if log_fn:
        log_fn("info", f"已写入输入文件: {input_path}")

    py = resolve_python(component_root, python_path=python_path, log_fn=log_fn)
    # Check requirements.txt against the resolved interpreter; install only the
    # missing packages (with live logs). Skips the 21-minute blind re-install.
    _ensure_requirements(py, component_root, log_fn)
    env = dict(os.environ)
    env.update(
        {
            "AGENT_UI_INPUT_PATH": input_path,
            "AGENT_UI_OUTPUT_PATH": output_path,
            "AGENT_UI_COMPONENT_ROOT": component_root,
        }
    )

    if log_fn:
        log_fn("info", f"启动组件进程: {py} {entry_point} (cwd={component_root})")
    t0 = time.time()

    # start_new_session puts the component in its own process group so a cancel
    # can kill the entire subtree (not just the immediate python interpreter).
    proc = subprocess.Popen(
        [py, entry_point],
        cwd=component_root,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        start_new_session=True,
    )

    logs = []
    exceptions = []

    def reader(stream, kind):
        try:
            for line in stream:
                if log_fn:
                    log_fn(kind, line.rstrip("\n"))
                logs.append((kind, line))
        except Exception as e:  # pragma: no cover - defensive
            exceptions.append(e)

    t_out = threading.Thread(target=reader, args=(proc.stdout, "stdout"), daemon=True)
    t_err = threading.Thread(target=reader, args=(proc.stderr, "stderr"), daemon=True)
    t_out.start()
    t_err.start()

    cancelled = False
    while proc.poll() is None:
        if cancel_check and cancel_check():
            _terminate_group(proc)
            cancelled = True
            if log_fn:
                log_fn("info", "组件进程已被取消")
            break
        time.sleep(poll)

    t_out.join()
    t_err.join()

    if log_fn:
        elapsed = time.time() - t0
        log_fn("info", f"组件进程结束: returncode={proc.returncode}, 耗时={elapsed:.1f}s")

    stdout_text = "".join(l for k, l in logs if k == "stdout")
    stderr_text = "".join(l for k, l in logs if k == "stderr")

    output_value = None
    if cancelled:
        if log_fn:
            log_fn("info", "组件被取消，跳过输出读取")
    elif os.path.exists(output_path):
        if log_fn:
            log_fn("info", f"已读取组件输出: {output_path}")
        try:
            with open(output_path) as f:
                output_value = json.load(f)
        except Exception:
            output_value = None
            if log_fn:
                log_fn("warning", "组件输出文件无法解析为 JSON")
    else:
        if log_fn:
            log_fn("warning", "组件未生成输出文件（可能未写 AGENT_UI_OUTPUT_PATH 或运行失败）")

    return {
        "success": (proc.returncode == 0 and not cancelled),
        "cancelled": cancelled,
        "returncode": proc.returncode,
        "stdout": stdout_text,
        "stderr": stderr_text,
        "output_path": output_path,
        "output_value": output_value,
    }


def _terminate_group(proc):
    """SIGTERM the component's process group, escalating to SIGKILL."""
    try:
        pgid = os.getpgid(proc.pid)
        os.killpg(pgid, signal.SIGTERM)
        proc.wait(timeout=5)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
    except ProcessLookupError:
        pass
