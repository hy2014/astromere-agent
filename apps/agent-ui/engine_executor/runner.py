"""Component environment preparation and execution.

Responsibilities (matching the agreed engine_executor scope):
  * prepare the environment (git clone + venv + pip install, cached by git url+branch)
  * run the component's entry point
  * stream stdout/stderr back to the caller (which persists them as logs)

The worker owns the state machine; this module is the "do the work" primitive.
"""

import hashlib
import json
import os
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
    """Resolve a component root directory, keeping it up to date.

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
    r = subprocess.run(
        ["git", "clone", "--depth", "1", "--branch", branch, git_url, root],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(
            f"git clone failed: requested branch '{branch}' not found "
            f"(or clone error): {r.stderr.strip()}"
        )
    if git_ref:
        try:
            _pin_ref(root, branch, git_ref)
        except RuntimeError as e:
            raise RuntimeError(f"git checkout ref '{git_ref}' failed: {e}")
    open(marker, "w").close()
    return root


def resolve_python(component_root):
    """Return the python binary to run the component with.

    If ``requirements.txt`` is non-empty we build/use a local ``.venv`` next to
    the component; otherwise we use the system ``python3``.
    """
    req = os.path.join(component_root, "requirements.txt")
    if os.path.exists(req) and os.path.getsize(req) > 0:
        venv = os.path.join(component_root, ".venv")
        py = os.path.join(venv, "bin", "python")
        py_win = os.path.join(venv, "Scripts", "python.exe")
        if not (os.path.exists(py) or os.path.exists(py_win)):
            subprocess.run(["python3", "-m", "venv", venv], check=True)
            target = py if os.path.exists(py) else py_win
            subprocess.run(
                [target, "-m", "pip", "install", "-r", req],
                check=True,
            )
        return py if os.path.exists(py) else py_win
    return "python3"


def run_node(
    component_root,
    entry_point,
    input_value,
    work_dir,
    cancel_check=None,
    poll=0.25,
    log_fn=None,
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

    py = resolve_python(component_root)
    env = dict(os.environ)
    env.update(
        {
            "AGENT_UI_INPUT_PATH": input_path,
            "AGENT_UI_OUTPUT_PATH": output_path,
            "AGENT_UI_COMPONENT_ROOT": component_root,
        }
    )

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
            break
        time.sleep(poll)

    t_out.join()
    t_err.join()

    stdout_text = "".join(l for k, l in logs if k == "stdout")
    stderr_text = "".join(l for k, l in logs if k == "stderr")

    output_value = None
    if os.path.exists(output_path) and not cancelled:
        try:
            with open(output_path) as f:
                output_value = json.load(f)
        except Exception:
            output_value = None

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
