import ctypes
from ctypes import wintypes
import sys

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

h_desk = user32.OpenDesktopW('Default', 0, False, 0x01FF)
if not h_desk:
    print('Failed to open Default desktop')
    sys.exit(1)

user32.SetThreadDesktop(h_desk)

zoom_windows = []

def enum_cb(hwnd, lparam):
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    length = user32.GetWindowTextLengthW(hwnd)
    buff = ctypes.create_unicode_buffer(length + 1)
    if length > 0:
        user32.GetWindowTextW(hwnd, buff, length + 1)
    cls_buff = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, cls_buff, 256)
    vis = bool(user32.IsWindowVisible(hwnd))
    
    # Check if process is zoom
    hProc = kernel32.OpenProcess(0x1000, False, pid.value) # PROCESS_QUERY_LIMITED_INFORMATION
    proc_name = ""
    if hProc:
        name_buff = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(1024)
        if kernel32.QueryFullProcessImageNameW(hProc, 0, name_buff, ctypes.byref(size)):
            proc_name = name_buff.value
        kernel32.CloseHandle(hProc)

    if 'zoom' in proc_name.lower() or 'zoom' in buff.value.lower() or 'zoom' in cls_buff.value.lower():
        zoom_windows.append((hwnd, pid.value, vis, cls_buff.value, buff.value, proc_name))
    return True

WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
user32.EnumDesktopWindows(h_desk, WNDENUMPROC(enum_cb), 0)

print(f"Found {len(zoom_windows)} Zoom windows:")
for hwnd, pid, vis, cls_name, title, proc in zoom_windows:
    print(f"  HWND:{hex(hwnd)} Vis:{vis} PID:{pid} Class:\"{cls_name}\" Title:\"{title}\"")
