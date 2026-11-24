import ctypes
from ctypes import wintypes
import subprocess
import time
import json
import sys
import os
from PIL import Image

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
kernel32 = ctypes.windll.kernel32

def attach_default_desktop():
    h_desk = user32.OpenDesktopW('Default', 0, False, 0x01FF)
    if h_desk:
        user32.SetThreadDesktop(h_desk)
    return h_desk

def capture_pil():
    attach_default_desktop()
    w = user32.GetSystemMetrics(0)
    h = user32.GetSystemMetrics(1)
    hdcScreen = user32.GetDC(0)
    hdcMem = gdi32.CreateCompatibleDC(hdcScreen)
    hbm = gdi32.CreateCompatibleBitmap(hdcScreen, w, h)
    gdi32.SelectObject(hdcMem, hbm)
    gdi32.BitBlt(hdcMem, 0, 0, w, h, hdcScreen, 0, 0, 0x00CC0020)

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [
            ('biSize', ctypes.c_uint32), ('biWidth', ctypes.c_int32), ('biHeight', ctypes.c_int32),
            ('biPlanes', ctypes.c_uint16), ('biBitCount', ctypes.c_uint16), ('biCompression', ctypes.c_uint32),
            ('biSizeImage', ctypes.c_uint32), ('biXPelsPerMeter', ctypes.c_int32), ('biYPelsPerMeter', ctypes.c_int32),
            ('biClrUsed', ctypes.c_uint32), ('biClrImportant', ctypes.c_uint32)
        ]

    bi = BITMAPINFOHEADER()
    bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bi.biWidth = w
    bi.biHeight = -h
    bi.biPlanes = 1
    bi.biBitCount = 32
    buf = bytearray(w * h * 4)
    gdi32.GetDIBits(hdcMem, hbm, 0, h, (ctypes.c_char * len(buf)).from_buffer(buf), ctypes.byref(bi), 0)
    im = Image.frombuffer('RGBA', (w, h), buf, 'raw', 'BGRA', 0, 1).convert('RGB')
    user32.ReleaseDC(0, hdcScreen)
    gdi32.DeleteDC(hdcMem)
    gdi32.DeleteObject(hbm)
    return im

def click_at(x, y):
    attach_default_desktop()
    user32.SetCursorPos(int(x), int(y))
    time.sleep(0.08)
    user32.mouse_event(0x0002, 0, 0, 0, 0)
    time.sleep(0.05)
    user32.mouse_event(0x0004, 0, 0, 0, 0)

def bring_to_front(hwnd):
    attach_default_desktop()
    user32.ShowWindow(hwnd, 9) # SW_RESTORE
    user32.SetWindowPos(hwnd, -1, 0, 0, 0, 0, 0x0002 | 0x0001 | 0x0040)
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.3)
    user32.SetWindowPos(hwnd, -2, 0, 0, 0, 0, 0x0002 | 0x0001 | 0x0040)

def send_alt_s():
    attach_default_desktop()
    VK_MENU = 0x12
    VK_S = 0x53
    KEYEVENTF_KEYUP = 0x0002
    user32.keybd_event(VK_MENU, 0, 0, 0)
    time.sleep(0.05)
    user32.keybd_event(VK_S, 0, 0, 0)
    time.sleep(0.05)
    user32.keybd_event(VK_S, 0, KEYEVENTF_KEYUP, 0)
    time.sleep(0.05)
    user32.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0)

def find_zoom_windows():
    attach_default_desktop()
    windows = []
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
        
        hProc = kernel32.OpenProcess(0x1000, False, pid.value)
        proc_name = ""
        if hProc:
            name_buff = ctypes.create_unicode_buffer(1024)
            size = wintypes.DWORD(1024)
            if kernel32.QueryFullProcessImageNameW(hProc, 0, name_buff, ctypes.byref(size)):
                proc_name = name_buff.value
            kernel32.CloseHandle(hProc)
        
        if 'zoom' in proc_name.lower() or 'zoom' in cls_buff.value.lower() or 'zoom' in buff.value.lower() or 'sharing frame' in cls_buff.value.lower():
            rect = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            windows.append({
                'hwnd': hex(hwnd),
                'hwnd_int': hwnd,
                'pid': pid.value,
                'visible': vis,
                'class': cls_buff.value,
                'title': buff.value,
                'rect': {'left': rect.left, 'top': rect.top, 'right': rect.right, 'bottom': rect.bottom}
            })
        return True

    h_desk = user32.OpenDesktopW('Default', 0, False, 0x01FF)
    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    user32.EnumDesktopWindows(h_desk, WNDENUMPROC(enum_cb), 0)
    return windows

def find_win(cls_substr, visible_only=True):
    for w in find_zoom_windows():
        if visible_only and not w['visible']:
            continue
        if cls_substr in w['class']:
            return w
    return None

def ensure_zoom_open():
    main_wnd = find_win('ZPPTMainFrmWndClassEx', visible_only=False)
    if not main_wnd:
        zoom_exe = r"C:\Program Files\Zoom\bin\Zoom.exe"
        if os.path.exists(zoom_exe):
            subprocess.Popen([zoom_exe], cwd=r"C:\Program Files\Zoom\bin")
            for _ in range(15):
                time.sleep(1)
                main_wnd = find_win('ZPPTMainFrmWndClassEx', visible_only=False)
                if main_wnd:
                    break
    if main_wnd:
        bring_to_front(main_wnd['hwnd_int'])
        main_wnd = find_win('ZPPTMainFrmWndClassEx', visible_only=False)
        return {'status': 'open', 'main_window': main_wnd}
    return {'status': 'error', 'message': 'Zoom main window not found'}

def click_video_preview_start():
    preview = find_win('VideoPreviewWndClass')
    if not preview:
        return False
    for attempt in range(4):
        preview = find_win('VideoPreviewWndClass')
        if not preview:
            return True
        bring_to_front(preview['hwnd_int'])
        time.sleep(0.5)
        pr = preview['rect']
        pim = capture_pil()
        bpts = []
        for y in range(max(0, pr['bottom'] - 100), min(pim.height, pr['bottom'])):
            for x in range(max(0, pr['right'] - 150), min(pim.width, pr['right'])):
                rr, gg, bb = pim.getpixel((x, y))
                if bb > 200 and rr < 40 and 80 < gg < 160:
                    bpts.append((x, y))
        if bpts:
            click_at(sum(p[0] for p in bpts) // len(bpts), sum(p[1] for p in bpts) // len(bpts))
        else:
            click_at(pr['right'] - 85, pr['bottom'] - 45)
        time.sleep(1.2)
        if not find_win('VideoPreviewWndClass'):
            return True
    return False

def start_new_meeting():
    # Check if already in a meeting or sharing
    if find_win('ConfMultiTabContentWndClass') or find_win('ZPFloatToolbarClass'):
        return {'status': 'already_in_meeting'}

    # If VideoPreviewWndClass is already open, just click Start on it
    if find_win('VideoPreviewWndClass'):
        click_video_preview_start()
    else:
        res = ensure_zoom_open()
        if res['status'] != 'open':
            return res
        main_wnd = res['main_window']
        r = main_wnd['rect']

        # Find orange "New meeting" button inside main window
        im = capture_pil()
        orange = []
        for y in range(max(0, r['top'] + 150), min(im.height, r['top'] + 400)):
            for x in range(max(0, r['left'] + 100), min(im.width, r['left'] + 500)):
                pr, pg, pb = im.getpixel((x, y))
                if pr > 200 and 70 < pg < 140 and pb < 60:
                    orange.append((x, y))
        if not orange:
            return {'status': 'error', 'message': 'New meeting orange button not found'}

        cx = sum(p[0] for p in orange) // len(orange)
        cy = sum(p[1] for p in orange) // len(orange)
        click_at(cx, cy)

        # Wait for either VideoPreviewWndClass or ConfMultiTabContentWndClass
        for _ in range(25):
            time.sleep(0.5)
            failed = find_win('zJoinMeetingFailedDlgClass')
            if failed:
                fr = failed['rect']
                click_at(fr['right'] - 70, fr['bottom'] - 45)
                time.sleep(0.5)
                return {'status': 'error', 'message': 'Meeting failed dialog appeared'}

            if find_win('VideoPreviewWndClass'):
                click_video_preview_start()
                break

            meeting = find_win('ConfMultiTabContentWndClass')
            if meeting:
                return {'status': 'in_meeting', 'window': meeting}

    # Wait for ConfMultiTabContentWndClass (up to 60s)
    for _ in range(120):
        time.sleep(0.5)
        failed = find_win('zJoinMeetingFailedDlgClass')
        if failed:
            fr = failed['rect']
            click_at(fr['right'] - 70, fr['bottom'] - 45)
            time.sleep(0.5)
            return {'status': 'error', 'message': 'Meeting failed dialog appeared'}
        meeting = find_win('ConfMultiTabContentWndClass')
        if meeting:
            return {'status': 'in_meeting', 'window': meeting}

    return {'status': 'error', 'message': 'Timed out waiting for Zoom Meeting window'}

def start_screen_share(mode='screen'):
    # mode: 'screen' (entire screen) or 'window' (first non-Zoom app window in picker, e.g. IDE/Browser)
    if find_win('ZPFloatToolbarClass'):
        return {'status': 'already_sharing', 'mode': mode}

    meeting = find_win('ConfMultiTabContentWndClass')
    if not meeting:
        mres = start_new_meeting()
        if mres.get('status') not in ('in_meeting', 'already_in_meeting'):
            return mres
        meeting = find_win('ConfMultiTabContentWndClass')

    if meeting:
        bring_to_front(meeting['hwnd_int'])
        time.sleep(0.3)

    # Open Share Picker with Alt+S
    send_alt_s()
    picker = None
    for _ in range(15):
        time.sleep(0.3)
        picker = find_win('ZPShareEntranceClass')
        if picker:
            break

    if not picker:
        return {'status': 'error', 'message': 'Share picker did not open'}

    bring_to_front(picker['hwnd_int'])
    time.sleep(0.3)
    pr = picker['rect']

    if mode == 'window':
        # In ZPShareEntranceClass, the "Windows" grid starts below "Screens".
        # Click the 3rd item in the first row of Windows (e.g. Antigravity IDE / active window)
        # Picker is ~1100x760. Row 1 of Windows is around top + 290, col 3 is around left + 470
        click_at(pr['left'] + 470, pr['top'] + 290)
        time.sleep(0.2)

    # Click blue Share button at bottom center of picker (left + width//2, bottom - 26)
    share_x = (pr['left'] + pr['right']) // 2
    share_y = pr['bottom'] - 26
    click_at(share_x, share_y)

    for _ in range(15):
        time.sleep(0.4)
        toolbar = find_win('ZPFloatToolbarClass')
        if toolbar:
            return {'status': 'sharing', 'mode': mode, 'toolbar': toolbar}

    return {'status': 'error', 'message': 'Timed out waiting for live screen sharing toolbar'}

def stop_screen_share():
    toolbar = find_win('ZPFloatToolbarClass')
    if not toolbar:
        return {'status': 'not_sharing'}
    # Alt+S toggles share off when sharing is active
    bring_to_front(toolbar['hwnd_int'])
    send_alt_s()
    for _ in range(10):
        time.sleep(0.3)
        if not find_win('ZPFloatToolbarClass'):
            return {'status': 'stopped'}
    return {'status': 'error', 'message': 'Could not stop share'}

def end_meeting():
    stop_screen_share()
    # Close any lingering preview / connecting / failed dialogs
    for cls in ('VideoPreviewWndClass', 'zWaitingMeetingIDWndClass', 'zJoinMeetingFailedDlgClass'):
        w = find_win(cls)
        if w:
            user32.PostMessageW(w['hwnd_int'], 0x0010, 0, 0) # WM_CLOSE
            time.sleep(0.3)
    meeting = find_win('ConfMultiTabContentWndClass')
    if not meeting:
        return {'status': 'no_meeting'}
    bring_to_front(meeting['hwnd_int'])
    time.sleep(0.2)
    # Alt+Q opens End Meeting prompt, then Enter confirms "End Meeting for All"
    attach_default_desktop()
    VK_MENU = 0x12
    VK_Q = 0x51
    VK_RETURN = 0x0D
    KEYEVENTF_KEYUP = 0x0002
    user32.keybd_event(VK_MENU, 0, 0, 0)
    time.sleep(0.05)
    user32.keybd_event(VK_Q, 0, 0, 0)
    time.sleep(0.05)
    user32.keybd_event(VK_Q, 0, KEYEVENTF_KEYUP, 0)
    user32.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0)
    time.sleep(0.5)
    user32.keybd_event(VK_RETURN, 0, 0, 0)
    time.sleep(0.05)
    user32.keybd_event(VK_RETURN, 0, KEYEVENTF_KEYUP, 0)
    time.sleep(1.0)
    return {'status': 'ended'}

def get_share_panel():
    toolbar = find_win('ZPFloatToolbarClass')
    if toolbar:
        # Hover top bar slightly so the toolbar / preview stays expanded
        tr = toolbar['rect']
        user32.SetCursorPos((tr['left'] + tr['right']) // 2, max(2, tr['top'] + 10))
        time.sleep(0.4)
    preview = None
    for w in find_zoom_windows():
        if w['visible'] and 'SharePreviewWnd' in w['title'] and w['rect']['right'] > w['rect']['left']:
            preview = w
            break
    toolbar = find_win('ZPFloatToolbarClass')
    return {'status': 'ok' if (toolbar or preview) else 'not_found', 'toolbar': toolbar, 'preview': preview}

if __name__ == '__main__':
    action = sys.argv[1] if len(sys.argv) > 1 else 'status'
    if action == 'status':
        wins = find_zoom_windows()
        vis = [w for w in wins if w['visible']]
        print(json.dumps({'total': len(wins), 'visible': len(vis), 'windows': vis}))
    elif action == 'open':
        print(json.dumps(ensure_zoom_open()))
    elif action == 'start_meeting':
        print(json.dumps(start_new_meeting()))
    elif action == 'start_share':
        mode = sys.argv[2] if len(sys.argv) > 2 else 'screen'
        print(json.dumps(start_screen_share(mode)))
    elif action == 'share_panel':
        print(json.dumps(get_share_panel()))
    elif action == 'stop_share':
        print(json.dumps(stop_screen_share()))
    elif action == 'end_meeting':
        print(json.dumps(end_meeting()))
