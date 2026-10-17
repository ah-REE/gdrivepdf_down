#!/usr/bin/env python3
"""editable_pptx.py - rebuild a view-only Drive deck as an editable .pptx.

Pipeline:
  1. bootstrap Google's viewer session (gdrive_down.viewer_bootstrap)
  2. fetch every slide render at W px (default 1600)
  3. fetch the per-slide text layer (viewer/presspage) with its
     block -> line -> word hierarchy (columns never merge)
  4. mask the baked text on each render and lay real editable text on top:
     - per-word colour sampling (mixed-colour paragraphs survive)
     - underline detected from the render pixels (not guessed)
     - block-consistent font size fitted to measured line widths
     - formula lines (=, math operators) stay baked, pixel-exact

Usage:
  python tools/editable_pptx.py "https://docs.google.com/presentation/d/<ID>/edit" -o out.pptx
  python tools/editable_pptx.py <file id> -o out.pptx --width 2000

Requires: requests, Pillow, python-pptx.
"""

import argparse
import io
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import gdrive_down as gd  # noqa: E402

from PIL import Image, ImageDraw, ImageFont  # noqa: E402
from pptx import Presentation  # noqa: E402
from pptx.dml.color import RGBColor  # noqa: E402
from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE, PP_ALIGN  # noqa: E402
from pptx.util import Pt  # noqa: E402

FONT_NAME = "Segoe UI"
FONT_PATH = r"C:\Windows\Fonts\segoeui.ttf"
WIDTH_DEFAULT = 1600
SIZE_FACTOR = 0.98
FIT_MIN, FIT_MAX = 0.92, 1.30
TINY_TEXT = 12
FORMULA_RE = re.compile(r"[=≈≠≤≥∑∫√±×÷]")
NO_SPACE_BEFORE = set("),.;:!?%”’")
NO_SPACE_AFTER = set("(«“‘")
_MEASURE = {}


def lum(c):
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def clean(text):
    out = "".join(ch for ch in text if not (0xE000 <= ord(ch) <= 0xF8FF))
    return " ".join(out.split())


def measure_width(text, size_px):
    if size_px < 4:
        return 0.0
    font = _MEASURE.get(size_px)
    if font is None:
        try:
            font = ImageFont.truetype(FONT_PATH, size_px)
        except OSError:
            font = False
        _MEASURE[size_px] = font
    if font is False:
        return 0.0
    try:
        return float(font.getlength(text))
    except Exception:
        return 0.0


def jparse(text):
    if text.startswith(")]}'"):
        text = text.split("\n", 1)[1]
    return json.loads(text)


def structured_lines(payload):
    """Walk block -> line -> word hierarchy; returns line dicts."""
    blocks = payload[3] if isinstance(payload, list) and len(payload) >= 4 else []
    out = []
    for bi, blk in enumerate(blocks):
        if not (isinstance(blk, list) and len(blk) == 2 and isinstance(blk[1], list)):
            continue
        blk_lines = []
        for ln in blk[1]:
            if not (
                isinstance(ln, list)
                and len(ln) == 2
                and isinstance(ln[0], list)
                and len(ln[0]) == 4
                and isinstance(ln[1], list)
            ):
                continue
            words = []
            for w in ln[1]:
                if (
                    isinstance(w, list)
                    and len(w) == 2
                    and isinstance(w[0], list)
                    and len(w[0]) == 4
                    and isinstance(w[1], str)
                ):
                    y, x, h, wd = w[0]
                    words.append({"x": x, "y": y, "w": wd, "h": h, "t": w[1]})
            if not words:
                continue
            words.sort(key=lambda r: r["x"])
            blk_lines.append(words)
        for li, words in enumerate(blk_lines):
            out.append(
                {
                    "block": bi,
                    "last": li == len(blk_lines) - 1,
                    "x": min(w["x"] for w in words),
                    "y": min(w["y"] for w in words),
                    "w": max(w["x"] + w["w"] for w in words) - min(w["x"] for w in words),
                    "h": max(w["h"] for w in words),
                    "words": words,
                }
            )
    return out


def fetch_slide_text(session, cfg, prev, page):
    r = session.get(
        "%s/viewer/%s&page=%d" % (gd._viewer_base(), cfg["presspage"], page),
        headers={"Referer": prev},
        timeout=(15, 60),
    )
    if r.status_code != 200:
        return []
    return structured_lines(jparse(r.text))


def fetch_render(session, cfg, prev, page, width, fssid):
    base = gd._viewer_base() + "/viewer/" + cfg["page"]
    url = ("%s&auditContext=forDisplay&page=%d&w=%d&webp=true&fssid=%s"
           % (base, page, width, fssid))
    for attempt in range(4):
        try:
            r = session.get(url, headers={"Referer": prev}, timeout=(15, 120))
        except gd.requests.RequestException:
            time.sleep(0.5 + 0.3 * attempt)
            continue
        if r.status_code == 200 and len(r.content) > 200:
            return r.content
        time.sleep(0.4 + 0.3 * attempt)
    return None


def _clamp_box(im, ln, scale):
    x0 = min(max(0.0, ln["x"] * scale), im.width - 1.0)
    y0 = min(max(0.0, ln["y"] * scale), im.height - 1.0)
    x1 = min(max(0.0, (ln["x"] + ln["w"]) * scale), im.width - 1.0)
    y1 = min(max(0.0, (ln["y"] + ln["h"]) * scale), im.height - 1.0)
    return x0, y0, x1, y1


def _ring_bg(im, x0, y0, x1, y1):
    ring = []
    top = int(max(0, y0 - 4))
    bottom = int(min(im.height - 1, y1 + 4))
    left = int(max(0, x0 - 4))
    right = int(min(im.width - 1, x1 + 4))
    for xx in range(int(x0), int(x1) + 1, 3):
        ring.append(im.getpixel((xx, top)))
        ring.append(im.getpixel((xx, bottom)))
    for yy in range(int(y0), int(y1) + 1, 3):
        ring.append(im.getpixel((left, yy)))
        ring.append(im.getpixel((right, yy)))
    ring.sort(key=lum)
    return ring[len(ring) // 2] if ring else (255, 255, 255)


def _text_color(im, x0, y0, x1, y1, bg):
    inner = []
    for xx in range(int(x0), int(x1) + 1, 2):
        for yy in range(int(y0), int(y1) + 1, 2):
            inner.append(im.getpixel((xx, yy)))
    cols = [c for c in inner if abs(lum(c) - lum(bg)) > 70]
    if not cols:
        return (0, 0, 0) if lum(bg) > 127 else (255, 255, 255)
    cols.sort(key=lum)
    return cols[0] if lum(bg) > 127 else cols[-1]


def _detect_word_underline(im, x0, y0, x1, y1, bg):
    """A nearly-solid dark band near the word's bottom edge = underline."""
    w = x1 - x0
    h = y1 - y0
    # short words (single glyphs) are nearly solid ink; ignore them
    if w < max(24.0, 1.6 * h) or h < 4:
        return False
    step = max(1, int(w / 24))
    rows_end = min(im.height - 1, int(y1) + 4)
    for yy in range(int(y0 + h * 0.60), rows_end + 1):
        dark = 0
        total = 0
        for xx in range(int(x0), int(x1), step):
            total += 1
            c = im.getpixel((xx, yy))
            if abs(lum(c) - lum(bg)) > 80:
                dark += 1
        if total and dark / total >= 0.85:
            return True
    return False


def _join_line(words):
    """Rebuild the line text with punctuation-aware spaces; return spans."""
    text = ""
    spans = []
    prev = None
    for w in words:
        if prev is not None:
            gap = w["x"] - (prev["x"] + prev["w"])
            piece = w["t"]
            if (
                piece
                and text
                and piece[0] not in NO_SPACE_BEFORE
                and text[-1] not in NO_SPACE_AFTER
                and not text.endswith(" ")
            ):
                text += " "
        start = len(text)
        text += w["t"]
        spans.append((start, len(text), w.get("color"), bool(w.get("underline"))))
        prev = w
    return text, spans


def build_deck(slides, renders, out_path):
    prs = Presentation()
    slide_w, slide_h = Pt(960), Pt(540)
    prs.slide_width, prs.slide_height = slide_w, slide_h
    blank = prs.slide_layouts[6]
    stats = {"boxes": 0, "chars": 0, "skipped": 0, "formula": 0, "underlined": 0}
    for lines, blob in zip(slides, renders):
        im = Image.open(io.BytesIO(blob)).convert("RGB")
        scale = im.width / 960.0
        draw = ImageDraw.Draw(im)
        items = []
        for ln in lines:
            words = []
            for w in ln["words"]:
                words.append(dict(w))
            text_probe = clean(" ".join(w["t"] for w in words))
            if len(text_probe) < 2 or not any(ch.isalnum() for ch in text_probe):
                stats["skipped"] += 1
                continue
            if FORMULA_RE.search(text_probe):
                stats["formula"] += 1
                continue
            x0, y0, x1, y1 = _clamp_box(im, ln, scale)
            if x1 - x0 < 2 or y1 - y0 < 2:
                stats["skipped"] += 1
                continue
            bg = _ring_bg(im, x0, y0, x1, y1)
            for w in words:
                wx0 = min(max(0.0, w["x"] * scale), im.width - 1.0)
                wy0 = min(max(0.0, w["y"] * scale), im.height - 1.0)
                wx1 = min(max(0.0, (w["x"] + w["w"]) * scale), im.width - 1.0)
                wy1 = min(max(0.0, (w["y"] + w["h"]) * scale), im.height - 1.0)
                if wx1 - wx0 >= 2 and wy1 - wy0 >= 2:
                    w["color"] = _text_color(im, wx0, wy0, wx1, wy1, bg)
                    w["underline"] = _detect_word_underline(im, wx0, wy0, wx1, wy1, bg)
                    if w["underline"]:
                        stats["underlined"] += 1
            text, spans = _join_line(words)
            text = clean(text)
            if len(text) < 2:
                stats["skipped"] += 1
                continue
            draw.rectangle([x0 - 2, y0 - 1, x1 + 2, y1 + 1], fill=bg)
            base = ln["h"] * SIZE_FACTOR
            size = base
            if len(text) > TINY_TEXT and ln["w"] > 4:
                measured = measure_width(text, int(round(base)))
                if measured > 0:
                    size = base * max(0.92, min(1.30, ln["w"] / measured))
            distribute = False
            items.append(
                {
                    "ln": ln,
                    "text": text,
                    "spans": spans,
                    "block": ln.get("block", 0),
                    "size": size,
                    "distribute": distribute,
                }
            )
            stats["boxes"] += 1
            stats["chars"] += len(text)

        # block-consistent sizes: median of fitted sizes within each block
        by_block = {}
        for it in items:
            by_block.setdefault(it["block"], []).append(it["size"])
        block_size = {b: sorted(v)[len(v) // 2] for b, v in by_block.items()}

        slide = prs.slides.add_slide(blank)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=90)
        buf.seek(0)
        slide.shapes.add_picture(buf, 0, 0, width=slide_w, height=slide_h)
        for it in items:
            ln = it["ln"]
            pad = 16
            box = slide.shapes.add_textbox(
                Pt(ln["x"] - 2), Pt(ln["y"] - 3), Pt(ln["w"] + pad), Pt(ln["h"] + 6)
            )
            tf = box.text_frame
            tf.word_wrap = False
            tf.auto_size = MSO_AUTO_SIZE.NONE
            tf.margin_left = 0
            tf.margin_right = 0
            tf.margin_top = 0
            tf.margin_bottom = 0
            tf.vertical_anchor = MSO_ANCHOR.MIDDLE
            p = tf.paragraphs[0]
            spans = it["spans"]
            text = it["text"]
            if not spans:
                spans = [(0, len(text), (0, 0, 0), False)]
            # merge spans into runs by quantised colour + underline flag
            runs = []
            for start, end, col, ul in spans:
                q = tuple((c // 24) if isinstance(c, tuple) else 0 for c in col)
                key = (q, ul)
                if runs and runs[-1][0] == key:
                    runs[-1] = (key, runs[-1][1], end, runs[-1][3], runs[-1][4])
                else:
                    runs.append((key, start, end, col, ul))
            size_pt = block_size.get(it["block"], it["size"])
            cursor = 0
            for _q, start, end, col, ul in runs:
                chunk = text[cursor:end]
                cursor = end
                if not chunk:
                    continue
                run = p.add_run()
                run.text = chunk
                f = run.font
                f.size = Pt(round(size_pt, 1))
                f.name = FONT_NAME
                f.bold = False
                if ul:
                    f.underline = True
                f.color.rgb = RGBColor(*col)
    prs.save(str(out_path))
    return stats


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="editable_pptx",
        description="Rebuild a view-only Google Slides deck as an editable .pptx "
                    "(render backgrounds with masked text + real text boxes).",
    )
    ap.add_argument("link", help="Docs/Drive link or file id")
    ap.add_argument("-o", "--out", default="editable.pptx", help="output .pptx path")
    ap.add_argument("--width", type=int, default=WIDTH_DEFAULT,
                    help="render width in px (default %d)" % WIDTH_DEFAULT)
    ap.add_argument("--keep-json", default=None,
                    help="also dump the extracted text model to this path")
    args = ap.parse_args(argv)

    fid, kind = gd.parse_file_id(args.link)
    if not fid:
        print("[!] Could not find a file id in %r" % args.link)
        return 1

    session = gd.new_session()
    cfg, prev, fssid = gd.viewer_bootstrap(session, fid, verbose=True)
    if "page" not in cfg or "presspage" not in cfg:
        print("[!] This file does not expose a page/text layer (is it a deck?)")
        return 1
    meta = jparse(
        session.get(gd._viewer_base() + "/viewer/" + cfg["meta"],
                    headers={"Referer": prev}, timeout=(15, 60)).text
    )
    pages = int(meta.get("pages") or 0)
    print("slides:", pages)

    renders, slides = [], []
    for page in range(pages):
        blob = fetch_render(session, cfg, prev, page, args.width, fssid)
        if blob is None:
            print("[!] slide %d render unavailable" % page)
            return 1
        renders.append(blob)
        slides.append(fetch_slide_text(session, cfg, prev, page))
        time.sleep(0.08)
        if (page + 1) % 10 == 0:
            sys.stdout.write("\r  fetched %d/%d" % (page + 1, pages))
            sys.stdout.flush()
    sys.stdout.write("\n")

    if args.keep_json:
        dump = Path(args.keep_json)
        dump.parent.mkdir(parents=True, exist_ok=True)
        dump.write_text(
            json.dumps({"slides": slides}, ensure_ascii=False), encoding="utf-8"
        )

    out = Path(args.out)
    if out.exists():
        out = Path(gd.unique_path(str(out)))
    stats = build_deck(slides, renders, out)
    print("built:", stats["boxes"], "text boxes |", stats["chars"], "chars |",
          stats["skipped"], "skipped |", stats["formula"], "formula lines baked |",
          stats["underlined"], "underlined")
    print("[OK] %s (%.2f MB)" % (out.resolve(), out.stat().st_size / 1e6))
    return 0


if __name__ == "__main__":
    sys.exit(main())
