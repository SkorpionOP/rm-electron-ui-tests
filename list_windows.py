import ctypes
from ctypes import wintypes

user32 = ctypes.windll.user32

def enum_windows():
    results = []
    def callback(hwnd, extra):
        if user32.IsWindowVisible(hwnd):
            length = user32.GetWindowTextLengthW(hwnd)
            buff = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buff, length + 1)
            title = buff.value
            cls_buff = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, cls_buff, 256)
            cls_name = cls_buff.value
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if title or cls_name:
                results.append((hwnd, pid.value, cls_name, title))
        return True
    
    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows(WNDENUMPROC(callback), 0)
    for hwnd, pid, cls, title in results:
        if title:
            print(f"HWND: {hex(hwnd):<10} PID: {pid:<6} Class: {cls:<25} Title: {title}")

if __name__ == '__main__':
    enum_windows()
