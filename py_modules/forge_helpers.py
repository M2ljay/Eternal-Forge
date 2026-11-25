"""The helper processes Forge started, found so an update can close them.

Decky v3.3.1 stops a plugin before replacing it, but on Windows that stop is
Process.terminate(), i.e. TerminateProcess: the plugin's _unload never runs
(the SIGTERM handler is installed on Linux only, sandboxed_plugin.py) and
Windows does not take a process's children down with it. A mod tool, a
ReShade setup or an archive tool Forge launched keeps running, keeps its
files open, and Decky's rmtree/extract then stops at the first of them.

Scope, deliberately narrow:
  * close   = a process descended from THIS backend whose executable lives
              under Forge's plugin folder or data folder;
  * blocker = a process NOT descended from us whose executable lives under
              the plugin folder (nothing ships one there, so it is ours from
              an earlier run, and it would break the copy). Reported, never
              killed: the user closes it.
Everything else is left alone, including a launcher in the data folder that
Steam started for a game (me3), which does not touch the plugin folder.

Standard library only (ctypes on Windows, /proc on Linux).
"""

import os
import sys
import time

ON_WINDOWS = sys.platform == "win32"


def _norm(path: str) -> str:
    try:
        path = os.path.realpath(path)
    except (OSError, ValueError):
        pass
    return os.path.normcase(os.path.abspath(path))


def under(path: str, root: str) -> bool:
    if not path or not root:
        return False
    p, r = _norm(path), _norm(root)
    try:
        return os.path.commonpath([p, r]) == r
    except ValueError:  # different drives
        return False


# ---- process table: {pid: (ppid, exe_path, start_key)} ---------------------
# start_key orders processes by creation, so a recycled pid is not taken for
# a child of a parent that started after it.

def _table_linux() -> dict:
    out = {}
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        pid = int(name)
        try:
            with open(f"/proc/{pid}/stat", "rb") as f:
                stat = f.read().decode("utf-8", "replace")
            fields = stat[stat.rindex(")") + 2:].split()
            ppid, start = int(fields[1]), int(fields[19])
        except (OSError, ValueError, IndexError):
            continue
        try:
            exe = os.readlink(f"/proc/{pid}/exe")
        except OSError:
            exe = ""
        if exe.endswith(" (deleted)"):
            exe = exe[: -len(" (deleted)")]
        out[pid] = (ppid, exe, start)
    return out


def _win():
    import ctypes
    from ctypes import wintypes

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                    ("th32ProcessID", wintypes.DWORD),
                    ("th32DefaultHeapID", ctypes.c_size_t),
                    ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                    ("th32ParentProcessID", wintypes.DWORD),
                    ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD),
                    ("szExeFile", ctypes.c_wchar * 260)]

    k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    k32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    k32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    k32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    k32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD,
                                               wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    k32.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    k32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    k32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    k32.WaitForSingleObject.restype = wintypes.DWORD
    return ctypes, wintypes, k32, PROCESSENTRY32W


_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_PROCESS_TERMINATE = 0x0001
_SYNCHRONIZE = 0x00100000


def _table_windows() -> dict:
    ctypes, wintypes, k32, ENTRY = _win()
    snap = k32.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
    if not snap or snap == wintypes.HANDLE(-1).value:
        return {}
    rows = []
    try:
        e = ENTRY()
        e.dwSize = ctypes.sizeof(ENTRY)
        ok = k32.Process32FirstW(snap, ctypes.byref(e))
        while ok:
            rows.append((int(e.th32ProcessID), int(e.th32ParentProcessID)))
            ok = k32.Process32NextW(snap, ctypes.byref(e))
    finally:
        k32.CloseHandle(snap)
    out = {}
    for pid, ppid in rows:
        exe, start = "", 0
        h = k32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if h:
            try:
                buf = ctypes.create_unicode_buffer(32768)
                size = wintypes.DWORD(len(buf))
                if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                    exe = buf.value
                times = [wintypes.FILETIME() for _ in range(4)]
                if k32.GetProcessTimes(h, *[ctypes.byref(t) for t in times]):
                    start = (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
            finally:
                k32.CloseHandle(h)
        out[pid] = (ppid, exe, start)
    return out


def process_table() -> dict:
    try:
        return _table_windows() if ON_WINDOWS else _table_linux()
    except Exception:  # noqa: BLE001 - no table means nothing found, never a crash
        return {}


def descendants(table: dict, root_pid: int) -> set:
    """Pids whose parent chain reaches root_pid, each started after its parent."""
    kids: dict = {}
    for pid, (ppid, _exe, _start) in table.items():
        kids.setdefault(ppid, []).append(pid)
    found, todo = set(), [root_pid]
    while todo:
        parent = todo.pop()
        p_start = table.get(parent, (0, "", 0))[2]
        for child in kids.get(parent, []):
            if child in found or child == root_pid:
                continue
            c_start = table[child][2]
            if p_start and c_start and c_start < p_start:
                continue  # a recycled pid: older than the "parent"
            found.add(child)
            todo.append(child)
    return found


def find(plugin_dir: str, data_dir: str, own_pid=None, table=None) -> dict:
    """{"close": [...], "blockers": [...]}, each item {"pid", "exe", "name"}."""
    own_pid = os.getpid() if own_pid is None else own_pid
    table = process_table() if table is None else table
    mine = descendants(table, own_pid)
    close, blockers = [], []
    for pid, (_ppid, exe, _start) in sorted(table.items()):
        if pid == own_pid or not exe:
            continue
        in_plugin = under(exe, plugin_dir)
        in_data = under(exe, data_dir)
        if not (in_plugin or in_data):
            continue
        item = {"pid": pid, "exe": exe, "name": os.path.basename(exe)}
        if pid in mine:
            close.append(item)
        elif in_plugin:
            blockers.append(item)
    return {"close": close, "blockers": blockers}


def _alive(pid: int) -> bool:
    if ON_WINDOWS:
        try:
            _ctypes, _wt, k32, _e = _win()
            h = k32.OpenProcess(_SYNCHRONIZE, False, pid)
            if not h:
                return False
            try:
                return k32.WaitForSingleObject(h, 0) != 0  # 0 = WAIT_OBJECT_0: exited
            finally:
                k32.CloseHandle(h)
        except Exception:  # noqa: BLE001
            return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    try:  # a zombie child of ours counts as gone
        with open(f"/proc/{pid}/stat", "rb") as f:
            return f.read().rsplit(b")", 1)[1].split()[0] != b"Z"
    except (OSError, IndexError):
        return False


def stop(items: list, plugin_dir: str, data_dir: str, own_pid=None, wait: float = 5.0) -> list:
    """Stop the listed processes, re-checked against a fresh table first:
    only a pid that is still our descendant with the same executable under
    our folders is touched. Returns the names of any still running."""
    own_pid = os.getpid() if own_pid is None else own_pid
    table = process_table()
    mine = descendants(table, own_pid)
    targets = []
    for it in items:
        pid = int(it.get("pid") or 0)
        row = table.get(pid)
        if (not row or pid not in mine or _norm(row[1]) != _norm(it.get("exe") or "")
                or not (under(row[1], plugin_dir) or under(row[1], data_dir))):
            continue
        targets.append((pid, row[1]))
    # Children before parents, so a tool's own launcher cannot respawn them.
    targets.sort(key=lambda t: -table[t[0]][2])
    for pid, _exe in targets:
        _terminate(pid)
    deadline = time.monotonic() + wait
    left = [t for t in targets if _alive(t[0])]
    while left and time.monotonic() < deadline:
        time.sleep(0.1)
        left = [t for t in left if _alive(t[0])]
    if not ON_WINDOWS:
        for pid, _exe in left:
            try:
                os.kill(pid, 9)
            except OSError:
                pass
        time.sleep(0.2)
        left = [t for t in left if _alive(t[0])]
    return [os.path.basename(exe) for _pid, exe in left]


def _terminate(pid: int) -> None:
    if not ON_WINDOWS:
        try:
            os.kill(pid, 15)
        except OSError:
            pass
        return
    try:
        _ctypes, _wt, k32, _e = _win()
        h = k32.OpenProcess(_PROCESS_TERMINATE | _SYNCHRONIZE, False, pid)
        if not h:
            return
        try:
            k32.TerminateProcess(h, 1)
            k32.WaitForSingleObject(h, 5000)
        finally:
            k32.CloseHandle(h)
    except Exception:  # noqa: BLE001
        pass

