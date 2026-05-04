"""
XtraWP icon.ico oluşturucu
Çalıştır: python create_icon.py
Gereksinim: pip install Pillow
"""

from PIL import Image, ImageDraw, ImageFont
import math, os

def lerp_color(c1, c2, t):
    return tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))

def draw_icon(size):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # --- Gradient arka plan ---
    c_top   = (45, 27, 105)   # #2d1b69
    c_mid   = (17, 40, 75)    # #11284b
    c_bot   = (37, 211, 102)  # #25D366
    radius  = int(size * 0.185)

    # Gradient: her satır için renk hesapla
    grad = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    for y in range(size):
        t = y / (size - 1)
        if t < 0.5:
            col = lerp_color(c_top, c_mid, t * 2)
        else:
            col = lerp_color(c_mid, c_bot, (t - 0.5) * 2)
        for x in range(size):
            grad.putpixel((x, y), col + (255,))

    # Rounded rect maske
    mask = Image.new('L', (size, size), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    img.paste(grad, (0, 0), mask)

    draw = ImageDraw.Draw(img)

    # --- Font yükleme (sisteme göre fallback) ---
    def load_font(size_px, bold=False):
        candidates_bold = [
            "arialbd.ttf", "Arial Bold.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "C:/Windows/Fonts/arialbd.ttf",
        ]
        candidates_reg = [
            "arial.ttf", "Arial.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "C:/Windows/Fonts/arial.ttf",
        ]
        pool = candidates_bold if bold else candidates_reg
        for path in pool:
            try:
                return ImageFont.truetype(path, size_px)
            except:
                pass
        return ImageFont.load_default()

    # --- "Xtra" yazısı (beyaz, büyük) ---
    xtra_size = int(size * 0.34)
    font_xtra = load_font(xtra_size, bold=True)
    text_xtra = "Xtra"

    bbox = draw.textbbox((0, 0), text_xtra, font=font_xtra)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (size - tw) // 2 - bbox[0]
    ty = int(size * 0.12) - bbox[1]
    draw.text((tx, ty), text_xtra, font=font_xtra, fill=(255, 255, 255, 255))

    # --- Ayırıcı çizgi ---
    line_y = int(size * 0.635)
    pad    = int(size * 0.07)
    line_alpha = 55
    draw.rectangle([pad, line_y, size - pad, line_y + max(1, int(size * 0.012))],
                   fill=(255, 255, 255, line_alpha))

    # --- "WP" yazısı (yeşil, letter-spaced simülasyonu) ---
    wp_size = int(size * 0.195)
    font_wp = load_font(wp_size, bold=True)
    wp_color = (37, 211, 102, 255)
    text_wp = "W  P"   # boşluk ile harf aralığı simüle et

    bbox2 = draw.textbbox((0, 0), text_wp, font=font_wp)
    tw2, th2 = bbox2[2] - bbox2[0], bbox2[3] - bbox2[1]
    tx2 = (size - tw2) // 2 - bbox2[0]
    ty2 = int(size * 0.685) - bbox2[1]
    draw.text((tx2, ty2), text_wp, font=font_wp, fill=wp_color)

    return img

# --- ICO oluştur (16, 32, 48, 64, 128, 256) ---
sizes = [256, 128, 64, 48, 32, 16]
images = [draw_icon(s) for s in sizes]

out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon.ico")
images[0].save(
    out_path,
    format='ICO',
    sizes=[(s, s) for s in sizes],
    append_images=images[1:]
)
print(f"✓ icon.ico oluşturuldu → {out_path}")
