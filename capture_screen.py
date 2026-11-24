import ctypes
from ctypes import wintypes
from PIL import Image, ImageChops, ImageDraw
import sys
import json
import os

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

def capture_desktop(out_path):
    h_desk = user32.OpenDesktopW('Default', 0, False, 0x01FF)
    if h_desk:
        user32.SetThreadDesktop(h_desk)

    w = user32.GetSystemMetrics(0)
    h = user32.GetSystemMetrics(1)
    hdcScreen = user32.GetDC(0)
    hdcMem = gdi32.CreateCompatibleDC(hdcScreen)
    hbm = gdi32.CreateCompatibleBitmap(hdcScreen, w, h)
    gdi32.SelectObject(hdcMem, hbm)

    SRCCOPY = 0x00CC0020
    gdi32.BitBlt(hdcMem, 0, 0, w, h, hdcScreen, 0, 0, SRCCOPY)

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
    
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    im.save(out_path)

    user32.ReleaseDC(0, hdcScreen)
    gdi32.DeleteDC(hdcMem)
    gdi32.DeleteObject(hbm)
    return im

def create_composite(screen_path, overlay_path, out_path, bx, by, bw, bh):
    im_screen = Image.open(screen_path)
    im_overlay = Image.open(overlay_path)
    crop_screen = im_screen.crop((bx, by, bx + bw, by + bh))
    W, H = bw * 2 + 60, bh + 80
    comp = Image.new('RGB', (W, H), (240, 245, 250))
    comp.paste(im_overlay.resize((bw, bh)), (20, 50))
    comp.paste(crop_screen, (bw + 40, 50))
    draw = ImageDraw.Draw(comp)
    draw.text((20, 20), "What Local User Sees (Physical Monitor)", fill=(0, 0, 0))
    draw.text((bw + 40, 20), "What Zoom Screen Share Sees (100% Concealed)", fill=(0, 120, 0))
    draw.rectangle([bw + 38, 48, bw + 42 + bw, 52 + bh], outline=(0, 180, 0), width=2)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    comp.save(out_path)
    return {'status': 'ok', 'out': out_path}

def capture_window(hwnd_int, out_path):
    h_desk = user32.OpenDesktopW('Default', 0, False, 0x01FF)
    if h_desk:
        user32.SetThreadDesktop(h_desk)
    rect = wintypes.RECT()
    user32.GetWindowRect(hwnd_int, ctypes.byref(rect))
    w = max(1, rect.right - rect.left)
    h = max(1, rect.bottom - rect.top)
    hdcScreen = user32.GetDC(0)
    hdcMem = gdi32.CreateCompatibleDC(hdcScreen)
    hbm = gdi32.CreateCompatibleBitmap(hdcScreen, w, h)
    gdi32.SelectObject(hdcMem, hbm)
    # PW_RENDERFULLCONTENT = 2
    user32.PrintWindow(hwnd_int, hdcMem, 2)

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
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    im.save(out_path)
    user32.ReleaseDC(0, hdcScreen)
    gdi32.DeleteDC(hdcMem)
    gdi32.DeleteObject(hbm)
    return {'status': 'ok', 'path': out_path, 'size': im.size}

def compare_images(img1_path, img2_path, diff_out_path, box=None):
    im1 = Image.open(img1_path)
    im2 = Image.open(img2_path)
    diff = ImageChops.difference(im1, im2)
    
    if box:
        crop_diff = diff.crop((box[0], box[1], box[0] + box[2], box[1] + box[3]))
    else:
        crop_diff = diff
    
    bbox = diff.getbbox()
    crop_bbox = crop_diff.getbbox()
    
    draw = ImageDraw.Draw(diff)
    if box:
        draw.rectangle([box[0], box[1], box[0] + box[2], box[1] + box[3]], outline="red", width=3)
    
    diff.save(diff_out_path)
    hist = crop_diff.histogram()
    total_pixels = crop_diff.size[0] * crop_diff.size[1]
    identical_approx = min(hist[0], hist[256], hist[512])
    diff_pixels = total_pixels - identical_approx
    diff_pct = (diff_pixels / total_pixels) * 100.0

    return {
        'diff_path': diff_out_path,
        'overall_bbox': bbox,
        'box_bbox': crop_bbox,
        'diff_pixels': diff_pixels,
        'total_pixels': total_pixels,
        'diff_pct': round(diff_pct, 2)
    }

def crop_region(img_path, out_path, x1, y1, x2, y2):
    im = Image.open(img_path)
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(im.width, x2), min(im.height, y2)
    cropped = im.crop((x1, y1, x2, y2))
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    cropped.save(out_path)
    return {'status': 'ok', 'path': out_path, 'size': cropped.size}

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'capture'
    if cmd == 'capture':
        out = sys.argv[2] if len(sys.argv) > 2 else 'screen.png'
        im = capture_desktop(out)
        print(json.dumps({'status': 'ok', 'path': out, 'size': im.size}))
    elif cmd == 'crop':
        img_p, out_p = sys.argv[2], sys.argv[3]
        b = [int(x) for x in sys.argv[4].split(',')]
        print(json.dumps(crop_region(img_p, out_p, b[0], b[1], b[2], b[3])))
    elif cmd == 'compare':
        img1, img2, out = sys.argv[2], sys.argv[3], sys.argv[4]
        box = [int(x) for x in sys.argv[5].split(',')] if len(sys.argv) > 5 else None
        res = compare_images(img1, img2, out, box)
        print(json.dumps(res))
    elif cmd == 'composite':
        screen_p, overlay_p, out_p = sys.argv[2], sys.argv[3], sys.argv[4]
        b = [int(x) for x in sys.argv[5].split(',')]
        res = create_composite(screen_p, overlay_p, out_p, b[0], b[1], b[2], b[3])
        print(json.dumps(res))
    elif cmd == 'capture_window':
        hwnd_int = int(sys.argv[2], 0)
        out_p = sys.argv[3]
        print(json.dumps(capture_window(hwnd_int, out_p)))
