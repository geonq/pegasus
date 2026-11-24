import sys
from PIL import Image
src = Image.open(sys.argv[1]).convert("RGBA")
a = src.getchannel("A").point(lambda v: 255 if v > 200 else 0)
l, t, r, b = a.getbbox()
inset = 16  # drops the Mac tile's own edge rim; iOS draws its own glass edge
tile = src.crop((l + inset, t + inset, r - inset, b - inset))
W, H = tile.size
px = tile.load()
def row_colour(y):
    for x in range(0, W // 2):
        if px[x, y][3] > 250:
            p = px[min(x + 20, W - 1), y]
            if p[3] > 250: return p[:3]
    return px[W // 2, y][:3]
bg = Image.new("RGB", (1, H))
for y in range(H): bg.putpixel((0, y), row_colour(y))
bg = bg.resize((W, H), Image.NEAREST).convert("RGBA")
out = Image.alpha_composite(bg, tile).convert("RGB").resize((1024, 1024), Image.LANCZOS)
out.save(sys.argv[2])
# Preview with the iOS mask (rounded rect, ~22.4% radius) on white, to judge it as the home screen shows it
from PIL import ImageDraw
m = Image.new("L", (1024, 1024), 0); ImageDraw.Draw(m).rounded_rectangle((0, 0, 1023, 1023), radius=229, fill=255)
prev = Image.new("RGB", (1124, 1124), (235, 235, 240)); prev.paste(out, (50, 50), m); prev.save(sys.argv[3])
print("ok", out.getpixel((2, 2)), out.getpixel((512, 2)))
