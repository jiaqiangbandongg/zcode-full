"""Regenerate cjk.pdf: non-embedded CJK fonts and radical code points in ToUnicode.

Standard library only, byte-for-byte reproducible. Run from this directory:
  python3 generate_cjk.py

Every CJK font on the page is deliberately NOT embedded, so the viewer has to pick system fonts:
  F0  STSong-Light, predefined CMap UniGB-UCS2-H (needs pdf.js cMaps)
  F1  a font named 黑体 in GBK bytes (/#BA#DA#CC#E5), flagged serif: the name must win
  F2  SimSun whose ToUnicode maps 文/玄/黄 to the radicals ⽂/⽞/⻩, as Chrome-printed PDFs do
  F3  KaiTi_GB2312
"""


def tounicode(pairs):
    lines = "\n".join(f"<{cid:04X}> <{ord(char):04X}>" for cid, char in pairs)
    body = (
        "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n"
        "/CMapName /Adobe-Identity-UCS def /CMapType 2 def\n"
        "1 begincodespacerange <0000> <FFFF> endcodespacerange\n"
        f"{len(pairs)} beginbfchar\n{lines}\nendbfchar\n"
        "endcmap CMapName currentdict /CMap defineresource pop end end"
    ).encode()
    return b"<< /Length %d >>\nstream\n" % len(body) + body + b"\nendstream"


def descriptor(name):
    return (
        f"<< /Type /FontDescriptor /FontName /{name} /Flags 6 /FontBBox [0 -141 996 855] "
        "/ItalicAngle 0 /Ascent 859 /Descent -141 /CapHeight 700 /StemV 80 >>"
    )


def identity_font(first, name, text):
    """Type0 + CIDFontType2 + descriptor + ToUnicode at objects first..first+3; returns (objs, hex)."""
    cids = list(range(100, 100 + len(text)))
    objs = {
        first: f"<< /Type /Font /Subtype /Type0 /BaseFont /{name} /Encoding /Identity-H "
        f"/DescendantFonts [{first + 1} 0 R] /ToUnicode {first + 3} 0 R >>",
        first + 1: f"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /{name} "
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> "
        f"/FontDescriptor {first + 2} 0 R /DW 1000 >>",
        first + 2: descriptor(name),
        first + 3: tounicode(list(zip(cids, text))),
    }
    return objs, "".join(f"{cid:04X}" for cid in cids)


def main():
    objs = {
        1: "<< /Type /Catalog /Pages 2 0 R >>",
        2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        3: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R "
        "/Resources << /Font << /F0 10 0 R /F1 20 0 R /F2 30 0 R /F3 40 0 R /F9 50 0 R >> >> >>",
        10: "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H "
        "/DescendantFonts [11 0 R] >>",
        11: "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light "
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> "
        "/FontDescriptor 12 0 R /DW 1000 >>",
        12: descriptor("STSong-Light"),
        50: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    }
    hei, hei_hex = identity_font(20, "#BA#DA#CC#E5", "黑体名称：中文排版测试")
    sun, sun_hex = identity_font(30, "SimSun", "天地⽞⻩，中⽂排版")
    kai, kai_hex = identity_font(40, "KaiTi_GB2312", "楷体：中文排版测试")
    objs.update(hei)
    objs.update(sun)
    objs.update(kai)
    song_hex = "宋体：中文排版测试".encode("utf-16-be").hex().upper()
    lines = [
        ("F0", song_hex, "F0 STSong-Light UniGB-UCS2-H"),
        ("F1", hei_hex, "F1 GBK-named heiti, serif flag"),
        ("F2", sun_hex, "F2 SimSun, radicals in ToUnicode"),
        ("F3", kai_hex, "F3 KaiTi_GB2312"),
    ]
    content = ""
    for i, (font, hex_text, label) in enumerate(lines):
        y = 760 - i * 70
        content += f"BT /F9 9 Tf 60 {y + 26} Td ({label}) Tj ET\n"
        content += f"BT /{font} 22 Tf 60 {y} Td <{hex_text}> Tj ET\n"
    stream = content.encode("latin-1")
    objs[4] = b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream"

    last = max(objs)
    data = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"
    offsets = {}
    for num in range(1, last + 1):
        body = objs.get(num, "null")
        body = body.encode("latin-1") if isinstance(body, str) else body
        offsets[num] = len(data)
        data += b"%d 0 obj\n" % num + body + b"\nendobj\n"
    xref = len(data)
    data += b"xref\n0 %d\n0000000000 65535 f \n" % (last + 1)
    data += b"".join(b"%010d 00000 n \n" % offsets[num] for num in range(1, last + 1))
    data += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (last + 1, xref)
    with open("cjk.pdf", "wb") as out:
        out.write(data)


if __name__ == "__main__":
    main()
