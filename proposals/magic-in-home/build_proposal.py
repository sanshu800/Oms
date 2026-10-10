#!/usr/bin/env python3
"""
Reygent AI — Order Desk Implementation Proposal for Magic in Home.

Builds a print-ready A4 PDF using ReportLab with embedded Inter and
Source Serif 4 (both SIL OFL, bundled in ./fonts).

    pip install reportlab
    python3 build_proposal.py            # -> Reygent-AI_Magic-in-Home_Order-Desk-Proposal.pdf

Every commercial figure lives in the CONFIG block below so the document
can be re-issued without touching layout code.
"""
from __future__ import annotations

import os
import sys

from reportlab.lib.colors import HexColor, white
from reportlab.lib.enums import TA_LEFT, TA_RIGHT, TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph, Table, TableStyle

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.join(HERE, "fonts")
OUT = os.path.join(HERE, "Reygent-AI_Magic-in-Home_Order-Desk-Proposal.pdf")

# ----------------------------------------------------------------------------
# CONFIG — commercial terms and document metadata
# ----------------------------------------------------------------------------
CLIENT = "Magic in Home"
PROVIDER = "Reygent AI"
TITLE = "Order Desk Implementation Proposal"
ISSUE_DATE = "10 October 2026"
REFERENCE = "RA-MIH-OD-2026-01"
SETUP_FEE = "₹25,000"
MONTHLY_FEE = "₹19,999"
DELIVERY_WINDOW = "3–4 weeks"
VALIDITY = "30 days from 10 October 2026"

WORKSTREAMS = [
    # (title, why it is required, amount_int)
    ("Discovery and workflow design",
     "Maps how phone and WhatsApp orders are taken today, confirms roles, approval "
     "rules and status definitions, and validates API access before any build begins.",
     3000),
    ("Order Desk interface, employee accounts, and permissions",
     "Builds the secure order-entry screens, employee and manager/admin accounts, "
     "role-based permissions, audit logging and the manager approval workflow.",
     6000),
    ("Shopify integration and order attribution",
     "Connects product and variant lookup, creates validated orders in Shopify and "
     "records which employee and channel (phone or WhatsApp) each order came from.",
     4000),
    ("Payment workflow configuration and reconciliation design",
     "Configures the Razorpay, verified-transfer and COD paths and designs how verified "
     "payments are referenced against the correct Shopify order.",
     4000),
    ("Shiprocket integration and status mapping",
     "Connects the Shiprocket events confirmed for your account and maps them to clear "
     "shipment, delivery and exception statuses.",
     2500),
    ("Manager dashboard, reporting, and Excel/CSV exports",
     "Delivers the team-wide overview, filters, employee-wise summaries and "
     "permission-aware .xlsx and .csv downloads.",
     2000),
    ("Reliability safeguards, testing, deployment, and handover",
     "Adds duplicate protection and error handling, runs end-to-end testing, deploys "
     "to production and walks your team through the system.",
     3500),
]
assert sum(w[2] for w in WORKSTREAMS) == 25000, "Workstream allocation must total ₹25,000"

# ----------------------------------------------------------------------------
# Design tokens
# ----------------------------------------------------------------------------
W, H = A4
ML = MR = 52            # side margins
CW = W - ML - MR        # content width
TOP = H - 92            # first content baseline area on interior pages
BOTTOM = 64             # nothing may be drawn below this on interior pages

NAVY = HexColor("#0B1F35")
NAVY_2 = HexColor("#14304D")
NAVY_3 = HexColor("#1E3D5E")
INK = HexColor("#17222D")
MUTED = HexColor("#56636F")
SOFT = HexColor("#8794A0")
RULE = HexColor("#DCE2E7")
BG = HexColor("#F3F5F6")
TEAL = HexColor("#0E8577")
TEAL_D = HexColor("#0A6E63")
TEAL_L = HexColor("#E3F1EE")
TEAL_ON_DARK = HexColor("#43C4B2")
ON_DARK = HexColor("#C5D0DA")
ON_DARK_SOFT = HexColor("#7F93A6")
AMBER_L = HexColor("#FBF4E6")
AMBER = HexColor("#9A6A12")


def register_fonts() -> None:
    faces = {
        "Inter": "Inter_400Regular.ttf",
        "Inter-Medium": "Inter_500Medium.ttf",
        "Inter-SemiBold": "Inter_600SemiBold.ttf",
        "Inter-Bold": "Inter_700Bold.ttf",
        "Serif-Light": "SourceSerif4_300Light.ttf",
        "Serif": "SourceSerif4_400Regular.ttf",
        "Serif-Italic": "SourceSerif4_400Regular_Italic.ttf",
        "Serif-SemiBold": "SourceSerif4_600SemiBold.ttf",
    }
    for name, fn in faces.items():
        pdfmetrics.registerFont(TTFont(name, os.path.join(FONTS, fn)))
    pdfmetrics.registerFontFamily("Inter", normal="Inter", bold="Inter-SemiBold",
                                  italic="Inter", boldItalic="Inter-SemiBold")
    pdfmetrics.registerFontFamily("Serif", normal="Serif", bold="Serif-SemiBold",
                                  italic="Serif-Italic", boldItalic="Serif-SemiBold")


register_fonts()


def S(name, **kw) -> ParagraphStyle:
    base = dict(fontName="Inter", fontSize=9.4, leading=14.2, textColor=INK,
                alignment=TA_LEFT, spaceBefore=0, spaceAfter=0)
    base.update(kw)
    return ParagraphStyle(name, **base)


ST = {
    "body": S("body"),
    "body_m": S("body_m", textColor=MUTED),
    "small": S("small", fontSize=8.4, leading=12.4, textColor=MUTED),
    "small_ink": S("small_ink", fontSize=8.4, leading=12.4),
    "tiny": S("tiny", fontSize=7.6, leading=11, textColor=MUTED),
    "lead": S("lead", fontName="Serif", fontSize=11.8, leading=17.4, textColor=MUTED),
    "h1": S("h1", fontName="Serif-Light", fontSize=25, leading=29.5, textColor=NAVY),
    "h2": S("h2", fontName="Inter-SemiBold", fontSize=11.2, leading=15, textColor=NAVY),
    "h3": S("h3", fontName="Inter-SemiBold", fontSize=9.6, leading=13.2, textColor=NAVY),
    "card_t": S("card_t", fontName="Inter-SemiBold", fontSize=9.2, leading=12.6, textColor=NAVY),
    "card_b": S("card_b", fontSize=8.4, leading=12.4, textColor=MUTED),
    "th": S("th", fontName="Inter-SemiBold", fontSize=7.6, leading=10, textColor=MUTED),
    "td": S("td", fontSize=8.5, leading=12.2),
    "td_m": S("td_m", fontSize=8.3, leading=12, textColor=MUTED),
    "td_b": S("td_b", fontName="Inter-SemiBold", fontSize=8.6, leading=12.2, textColor=NAVY),
    "td_r": S("td_r", fontName="Inter-SemiBold", fontSize=9, leading=12.2, textColor=NAVY,
              alignment=TA_RIGHT),
    "td_c": S("td_c", fontSize=8.4, leading=12, alignment=TA_CENTER),
}


# ----------------------------------------------------------------------------
# Low-level helpers
# ----------------------------------------------------------------------------
class Doc:
    def __init__(self, path: str):
        self.c = canvas.Canvas(path, pagesize=A4)
        self.c.setTitle(f"{TITLE} — {CLIENT}")
        self.c.setAuthor(PROVIDER)
        self.c.setSubject("Technical and commercial implementation proposal")
        self.c.setCreator(f"{PROVIDER} proposal builder")
        self.c.setKeywords("Order Desk, Shopify, Razorpay, Shiprocket, proposal")
        self.page = 0
        self.total = 8
        self.lowest = H
        self.warnings: list[str] = []

    # tracking of the lowest drawn point for layout safety
    def mark(self, y: float):
        self.lowest = min(self.lowest, y)

    def check_page(self, label: str):
        if self.lowest < BOTTOM - 0.5:
            self.warnings.append(f"Page {self.page} ({label}) overflows: lowest y={self.lowest:.1f}")


def ph(text: str, w: float, style: ParagraphStyle) -> float:
    p = Paragraph(text, style)
    _, h = p.wrap(w, 10_000)
    return h


def para(d: Doc, text: str, x: float, y: float, w: float, style: ParagraphStyle) -> float:
    """Draw paragraph with its TOP edge at y. Returns height used."""
    p = Paragraph(text, style)
    _, h = p.wrap(w, 10_000)
    p.drawOn(d.c, x, y - h)
    d.mark(y - h)
    return h


def tracked(c, text, x, y, font="Inter-SemiBold", size=7.4, color=TEAL, space=1.3,
            align="left"):
    width = pdfmetrics.stringWidth(text, font, size) + space * (len(text) - 1)
    if align == "right":
        x -= width
    elif align == "center":
        x -= width / 2
    c.saveState()
    t = c.beginText(x, y)
    t.setFont(font, size)
    t.setCharSpace(space)
    t.setFillColor(color)
    t.textLine(text)
    t.setCharSpace(0)
    c.drawText(t)
    c.restoreState()
    return width


def text(c, s, x, y, font="Inter", size=9, color=INK, align="left"):
    c.setFont(font, size)
    c.setFillColor(color)
    if align == "right":
        c.drawRightString(x, y, s)
    elif align == "center":
        c.drawCentredString(x, y, s)
    else:
        c.drawString(x, y, s)


def rrect(c, x, y, w, h, r=6, fill=None, stroke=None, lw=0.7):
    c.saveState()
    if fill is not None:
        c.setFillColor(fill)
    if stroke is not None:
        c.setStrokeColor(stroke)
        c.setLineWidth(lw)
    c.roundRect(x, y, w, h, r, stroke=1 if stroke is not None else 0,
                fill=1 if fill is not None else 0)
    c.restoreState()


def hline(c, x1, x2, y, color=RULE, lw=0.6):
    c.saveState()
    c.setStrokeColor(color)
    c.setLineWidth(lw)
    c.line(x1, y, x2, y)
    c.restoreState()


def arrow(c, x1, y1, x2, y2, color=SOFT, lw=0.8, head=3.4):
    import math
    c.saveState()
    c.setStrokeColor(color)
    c.setFillColor(color)
    c.setLineWidth(lw)
    c.line(x1, y1, x2, y2)
    a = math.atan2(y2 - y1, x2 - x1)
    p = c.beginPath()
    p.moveTo(x2, y2)
    p.lineTo(x2 - head * math.cos(a - 0.45) * 1.6, y2 - head * math.sin(a - 0.45) * 1.6)
    p.lineTo(x2 - head * math.cos(a + 0.45) * 1.6, y2 - head * math.sin(a + 0.45) * 1.6)
    p.close()
    c.drawPath(p, stroke=0, fill=1)
    c.restoreState()


def logo_mark(c, x, y, s=16, dark_bg=False):
    """Reygent monogram: rounded tile with a geometric R (white stem/bowl, teal leg)."""
    c.saveState()
    tile = NAVY if not dark_bg else HexColor("#FFFFFF")
    fg = white if not dark_bg else NAVY
    rrect(c, x, y, s, s, r=s * 0.24, fill=tile)
    lw = s * 0.115
    c.setLineWidth(lw)
    c.setLineCap(1)
    c.setLineJoin(1)
    c.setStrokeColor(fg)
    sx, top, bot = x + s * 0.32, y + s * 0.76, y + s * 0.24
    mid = y + s * 0.50
    # stem
    c.line(sx, bot, sx, top)
    # bowl
    p = c.beginPath()
    p.moveTo(sx, top)
    p.lineTo(x + s * 0.54, top)
    p.curveTo(x + s * 0.73, top, x + s * 0.73, mid, x + s * 0.54, mid)
    p.lineTo(sx, mid)
    c.drawPath(p, stroke=1, fill=0)
    # leg (teal accent)
    c.setStrokeColor(TEAL_ON_DARK if not dark_bg else TEAL)
    c.line(x + s * 0.52, mid, x + s * 0.70, bot)
    c.restoreState()


def wordmark(c, x, y, size=10.5, dark_bg=False):
    mark_s = size * 1.55
    logo_mark(c, x, y - mark_s * 0.26, mark_s, dark_bg=False if not dark_bg else False)
    tx = x + mark_s + size * 0.55
    c.setFont("Inter-SemiBold", size)
    c.setFillColor(white if dark_bg else NAVY)
    c.drawString(tx, y, "Reygent")
    tw = pdfmetrics.stringWidth("Reygent", "Inter-SemiBold", size)
    c.setFillColor(TEAL_ON_DARK if dark_bg else TEAL)
    c.drawString(tx + tw + size * 0.28, y, "AI")


def bullets(d: Doc, items, x, y, w, style=None, gap=4.2, marker="dash", color=TEAL,
            indent=12):
    style = style or ST["body"]
    total = 0
    for it in items:
        h = ph(it, w - indent, style)
        top = y - total
        cy = top - style.leading * 0.5 - 0.6
        d.c.saveState()
        d.c.setFillColor(color)
        d.c.setStrokeColor(color)
        if marker == "dash":
            d.c.setLineWidth(1.1)
            d.c.line(x, cy + 1.2, x + 5.5, cy + 1.2)
        elif marker == "dot":
            d.c.circle(x + 2.2, cy + 1.2, 1.5, stroke=0, fill=1)
        elif marker == "check":
            d.c.setLineWidth(1.1)
            d.c.setLineCap(1)
            d.c.setLineJoin(1)
            p = d.c.beginPath()
            p.moveTo(x, cy + 1.4)
            p.lineTo(x + 2.3, cy - 0.9)
            p.lineTo(x + 6.6, cy + 3.8)
            d.c.drawPath(p, stroke=1, fill=0)
        elif marker == "cross":
            d.c.setLineWidth(1.0)
            d.c.setLineCap(1)
            d.c.line(x + 0.6, cy - 1.4, x + 5.6, cy + 3.6)
            d.c.line(x + 0.6, cy + 3.6, x + 5.6, cy - 1.4)
        d.c.restoreState()
        para(d, it, x + indent, top, w - indent, style)
        total += h + gap
    return total - gap


def bullets_h(items, w, style=None, gap=4.2, indent=12):
    style = style or ST["body"]
    return sum(ph(it, w - indent, style) for it in items) + gap * (len(items) - 1)


def chip(c, label, x, y, fill=TEAL_L, color=TEAL_D, size=7.2, pad=5.5, h=13):
    """Pill with baseline-centred label; (x, y) is bottom-left. Returns width."""
    tw = pdfmetrics.stringWidth(label, "Inter-SemiBold", size)
    w = tw + pad * 2
    rrect(c, x, y, w, h, r=h / 2, fill=fill)
    text(c, label, x + pad, y + h / 2 - size * 0.36, "Inter-SemiBold", size, color)
    return w


def table(d: Doc, data, col_w, x, y, style_cmds, ) -> float:
    t = Table(data, colWidths=col_w)
    t.setStyle(TableStyle(style_cmds))
    _, h = t.wrapOn(d.c, sum(col_w), 10_000)
    t.drawOn(d.c, x, y - h)
    d.mark(y - h)
    return h


def table_h(data, col_w, style_cmds, c) -> float:
    t = Table(data, colWidths=col_w)
    t.setStyle(TableStyle(style_cmds))
    _, h = t.wrapOn(c, sum(col_w), 10_000)
    return h


# ----------------------------------------------------------------------------
# Page furniture
# ----------------------------------------------------------------------------
SECTION_NAMES = {}


def interior_page(d: Doc, section_no: str, section: str):
    d.page += 1
    d.lowest = H
    c = d.c
    SECTION_NAMES[d.page] = section
    # header
    wordmark(c, ML, H - 46, size=9.6)
    text(c, f"{TITLE}", W - MR, H - 42.5, "Inter-Medium", 7.6, MUTED, align="right")
    text(c, f"Prepared for {CLIENT}", W - MR, H - 52.5, "Inter", 7.2, SOFT, align="right")
    hline(c, ML, W - MR, H - 64)
    # footer
    hline(c, ML, W - MR, 44)
    text(c, f"{PROVIDER}  ·  Confidential proposal for {CLIENT}  ·  Ref. {REFERENCE}",
         ML, 30, "Inter", 7, SOFT)
    text(c, f"{d.page:02d}", W - MR - 20, 30, "Inter-SemiBold", 7.4, NAVY, align="right")
    text(c, f" / {d.total:02d}", W - MR, 30, "Inter", 7.4, SOFT, align="right")


def section_head(d: Doc, no: str, label: str, headline: str, lead: str | None = None,
                 lead_w: float = CW - 10) -> float:
    c = d.c
    y = TOP
    tracked(c, no, ML, y, "Inter-SemiBold", 7.4, TEAL, 1.2)
    nw = pdfmetrics.stringWidth(no, "Inter-SemiBold", 7.4) + 1.2 * (len(no) - 1)
    hline(c, ML + nw + 6, ML + nw + 24, y + 2.6, TEAL, 0.8)
    tracked(c, label.upper(), ML + nw + 30, y, "Inter-SemiBold", 7.4, TEAL, 1.3)
    y -= 13
    y -= para(d, headline, ML, y, CW, ST["h1"])
    if lead:
        y -= 7
        y -= para(d, lead, ML, y, lead_w, ST["lead"])
    return y


def sub_head(d: Doc, label: str, x: float, y: float, w: float, rule=True) -> float:
    h = para(d, label, x, y, w, ST["h2"])
    if rule:
        hline(d.c, x, x + w, y - h - 5)
        return h + 13
    return h + 6


# ----------------------------------------------------------------------------
# Page 1 — Cover
# ----------------------------------------------------------------------------
def page_cover(d: Doc):
    d.page += 1
    c = d.c
    c.setFillColor(NAVY)
    c.rect(0, 0, W, H, stroke=0, fill=1)

    # top bar
    wordmark(c, ML, H - 62, size=12, dark_bg=True)
    tracked(c, "PROPOSAL  ·  OCTOBER 2026", W - MR, H - 60, "Inter-Medium", 7.2,
            ON_DARK_SOFT, 1.4, align="right")
    hline(c, ML, W - MR, H - 84, NAVY_3, 0.6)

    # title block
    y = H - 158
    tracked(c, "TECHNICAL & COMMERCIAL IMPLEMENTATION PROPOSAL", ML, y,
            "Inter-SemiBold", 7.6, TEAL_ON_DARK, 1.6)
    y -= 18
    title_style = S("cover_t", fontName="Serif-Light", fontSize=46, leading=50,
                    textColor=white)
    y -= para(d, "Order Desk<br/>Implementation Proposal", ML, y, CW, title_style)
    y -= 18
    pf = S("cover_pf", fontName="Inter", fontSize=11.5, leading=16, textColor=ON_DARK)
    y -= para(d, f"Prepared for <font name='Inter-SemiBold' color='#FFFFFF'>{CLIENT}</font>",
              ML, y, CW, pf)
    y -= 22
    desc = S("cover_d", fontName="Serif", fontSize=13.2, leading=20.5, textColor=ON_DARK)
    y -= para(d,
              "A Shopify-connected order desk that gives the Magic in Home team one "
              "structured place to enter phone and WhatsApp orders, with employee "
              "attribution, clear payment and delivery visibility, and management "
              "reporting built in. It works alongside Shopify, Razorpay and Shiprocket, "
              "without replacing them.",
              ML, y, 380, desc)

    # schematic — conversation → Order Desk → existing platforms
    cover_schematic(c, top=y - 34)

    # commercial band
    band_top = 178
    hline(c, ML, W - MR, band_top, NAVY_3, 0.6)
    col = CW / 3
    figs = [
        ("ONE-TIME IMPLEMENTATION", SETUP_FEE, ""),
        ("MONTHLY SAAS SUBSCRIPTION", MONTHLY_FEE, "/ month"),
        ("ESTIMATED DELIVERY WINDOW", DELIVERY_WINDOW, ""),
    ]
    for i, (lab, val, suf) in enumerate(figs):
        x = ML + i * col + (0 if i == 0 else 16)
        if i:
            c.setStrokeColor(NAVY_3)
            c.setLineWidth(0.6)
            c.line(ML + i * col, band_top - 18, ML + i * col, band_top - 86)
        tracked(c, lab, x, band_top - 30, "Inter-SemiBold", 6.8, ON_DARK_SOFT, 1.2)
        text(c, val, x, band_top - 64, "Serif-Light", 28, white)
        if suf:
            vw = pdfmetrics.stringWidth(val, "Serif-Light", 28)
            text(c, suf, x + vw + 5, band_top - 64, "Inter", 9.5, ON_DARK)
    note = S("cover_n", fontName="Inter", fontSize=7.8, leading=11.5, textColor=ON_DARK_SOFT)
    para(d, "Taxes and third-party provider charges are additional, where applicable. "
            "The delivery window starts once discovery is confirmed and system access has "
            "been provided.", ML, band_top - 100, CW, note)

    # footer
    hline(c, ML, W - MR, 48, NAVY_3, 0.6)
    text(c, f"Prepared by {PROVIDER}  ·  Issued {ISSUE_DATE}  ·  Ref. {REFERENCE}",
         ML, 32, "Inter", 7.2, ON_DARK_SOFT)
    text(c, "Confidential", W - MR, 32, "Inter-Medium", 7.2, ON_DARK_SOFT, align="right")
    c.showPage()


def cover_schematic(c, top: float):
    """Thin-line diagram: Phone/WhatsApp → Order Desk → Shopify / Razorpay / Shiprocket."""
    h = 104
    cy = top - h / 2
    line = HexColor("#2C4A6A")
    # left: sources
    srcs = ["Phone orders", "WhatsApp orders"]
    for i, s in enumerate(srcs):
        y = cy + 16 - i * 32
        rrect(c, ML, y - 11, 112, 22, r=11, stroke=line, lw=0.8)
        text(c, s, ML + 56, y - 3, "Inter-Medium", 8, ON_DARK, align="center")
        arrow(c, ML + 112, y, ML + 178, cy, color=line, lw=0.8, head=2.6)
    # centre: order desk
    bx, bw, bh = ML + 182, 132, 46
    rrect(c, bx, cy - bh / 2, bw, bh, r=8, fill=NAVY_2, stroke=TEAL_ON_DARK, lw=1)
    text(c, "Order Desk", bx + bw / 2, cy + 2, "Inter-SemiBold", 10.5, white, align="center")
    text(c, "PROPOSED", bx + bw / 2, cy - 12, "Inter-SemiBold", 6.4, TEAL_ON_DARK,
         align="center")
    # right: platforms
    plats = [("Shopify", "orders & products"), ("Razorpay", "payments"),
             ("Shiprocket", "shipping & delivery")]
    rx = W - MR - 150
    for i, (n, sub) in enumerate(plats):
        y = cy + 36 - i * 36
        arrow(c, bx + bw, cy, rx - 4, y, color=line, lw=0.8, head=2.6)
        rrect(c, rx, y - 13, 150, 26, r=6, stroke=line, lw=0.8)
        text(c, n, rx + 11, y - 3.2, "Inter-SemiBold", 8.4, white)
        nw = pdfmetrics.stringWidth(n, "Inter-SemiBold", 8.4)
        text(c, sub, rx + 11 + nw + 6, y - 3.2, "Inter", 7.6, ON_DARK_SOFT)
    text(c, "Existing platforms remain in place", rx + 75, cy - 62, "Inter", 7,
         ON_DARK_SOFT, align="center")


# ----------------------------------------------------------------------------
# Page 2 — Executive summary
# ----------------------------------------------------------------------------
def page_exec(d: Doc):
    interior_page(d, "01", "Executive summary")
    c = d.c
    y = section_head(
        d, "01", "Executive summary",
        "One structured desk for every phone and WhatsApp order.",
        "Reygent AI proposes to configure and implement a secure, Shopify-connected Order "
        "Desk where the Magic in Home team enters and tracks phone and WhatsApp orders, and "
        "where managers see payment, delivery and team performance in one place.")
    y -= 22

    # two columns: narrative + context card
    lw = 300
    gx = ML + lw + 24
    rw = CW - lw - 24
    top = y
    yy = top
    yy -= sub_head(d, "Current operating context", ML, yy, lw)
    yy -= para(d,
               "Magic in Home processes approximately <b>1,000 orders a month</b>. Shopify "
               "holds orders and products, Razorpay handles payments, and Shiprocket "
               "manages shipping and delivery. Orders received over phone and WhatsApp are "
               "captured by team members and entered into Shopify.", ML, yy, lw, ST["body"])
    yy -= 14
    yy -= sub_head(d, "Why a centralized order workflow helps", ML, yy, lw)
    yy -= para(d,
               "When orders begin as conversations, a single guided entry point means every "
               "team member captures the same details in the same way. Each order carries "
               "the name of the person who entered it and the channel it came from, and "
               "managers can follow payment and delivery progress without switching between "
               "systems. At around 1,000 orders a month, that consistency adds up.",
               ML, yy, lw, ST["body"])
    left_bottom = yy

    # context card
    facts = [
        ("~1,000", "orders per month"),
        ("Shopify", "orders and products"),
        ("Razorpay", "payments"),
        ("Shiprocket", "shipping and delivery"),
    ]
    step = 32
    card_h = 30 + len(facts) * step
    rrect(c, gx, top - card_h, rw, card_h, r=8, fill=BG)
    tracked(c, "TODAY'S SYSTEMS", gx + 16, top - 20, "Inter-SemiBold", 6.8, MUTED, 1.2)
    fy = top - 30
    for i, (big, small) in enumerate(facts):
        if i:
            hline(c, gx + 16, gx + rw - 16, fy + 1)
        text(c, big, gx + 16, fy - 15, "Serif", 14 if i == 0 else 12.4, NAVY)
        text(c, small, gx + 16, fy - 27, "Inter", 7.6, MUTED)
        fy -= step
    d.mark(top - card_h)
    # proposal status note beneath the card
    ny = top - card_h - 10
    note = ("<font name='Inter-SemiBold' color='#0A6E63'>Proposal status.</font> "
            "This is a proposal for a system to be configured and implemented. "
            "Nothing here has been deployed yet.")
    nst = S("ps", fontSize=7.8, leading=11.4, textColor=INK)
    nh = ph(note, rw - 24, nst) + 20
    rrect(c, gx, ny - nh, rw, nh, r=8, fill=TEAL_L)
    para(d, note, gx + 12, ny - 10, rw - 24, nst)
    y = min(left_bottom, ny - nh) - 20

    # How it fits — diagram
    y -= sub_head(d, "How the Order Desk fits alongside existing systems", ML, y, CW)
    y = fit_diagram(d, y)
    y -= 18

    # Intended benefits — five columns
    y -= sub_head(d, "Intended benefits", ML, y, CW)
    benefits = [
        ("Consistent order entry", "Guided screens with product and variant lookup, so "
                                   "orders are captured in a standard format."),
        ("Clear accountability", "Each order is attributed to the employee who entered it "
                                 "and to its source: phone or WhatsApp."),
        ("Clearer payment status", "Razorpay, verified transfer and COD orders each follow "
                                   "a defined, visible payment path."),
        ("Delivery visibility", "Supported Shiprocket events update shipment and delivery "
                                "status in the Order Desk."),
        ("Management reporting", "Team-wide dashboards with Excel and CSV exports by date, "
                                 "employee and status."),
    ]
    n = len(benefits)
    g = 12
    bw = (CW - g * (n - 1)) / n
    bst = S("bb", fontSize=7.7, leading=11.2, textColor=MUTED)
    tst = S("bt", fontName="Inter-SemiBold", fontSize=8.8, leading=11.6, textColor=NAVY)
    th = max(ph(t, bw, tst) for t, _ in benefits)
    for i, (t, b) in enumerate(benefits):
        x = ML + i * (bw + g)
        text(c, f"{i + 1:02d}", x, y - 8, "Inter-SemiBold", 7.4, TEAL)
        para(d, t, x, y - 16, bw, tst)
        para(d, b, x, y - 20 - th, bw, bst)
    d.check_page("exec")
    c.showPage()


def fit_diagram(d: Doc, y: float) -> float:
    c = d.c
    h = 102
    base = y - h
    col1_x, col1_w = ML, 112
    col2_x, col2_w = ML + 140, 146
    col3_x = ML + 316
    col3_w = CW - 316
    mid = base + h / 2
    # col 1: team
    rrect(c, col1_x, mid - 28, col1_w, 56, r=8, stroke=RULE, fill=white)
    text(c, "Sales and order team", col1_x + 11, mid + 9, "Inter-SemiBold", 8.2, NAVY)
    para(d, "Takes orders over phone and WhatsApp", col1_x + 11, mid + 2, col1_w - 20,
         S("dg", fontSize=7.4, leading=10.2, textColor=MUTED))
    arrow(c, col1_x + col1_w + 4, mid, col2_x - 6, mid, SOFT, 0.9)
    # col 2: order desk
    rrect(c, col2_x, mid - 40, col2_w, 80, r=8, fill=NAVY)
    tracked(c, "PROPOSED", col2_x + 14, mid + 24, "Inter-SemiBold", 6.2, TEAL_ON_DARK, 1.2)
    text(c, "Order Desk", col2_x + 14, mid + 8, "Inter-SemiBold", 11, white)
    para(d, "Structured entry, attribution, permissions, approvals and reporting",
         col2_x + 14, mid - 1, col2_w - 26, S("dg2", fontSize=7.4, leading=10.4,
                                              textColor=ON_DARK))
    # col 3: platforms
    plats = [("Shopify", "System of record for orders and products"),
             ("Razorpay", "Continues to process online payments"),
             ("Shiprocket", "Continues to manage shipping and delivery")]
    ph_ = 30
    gap = (h - ph_ * 3) / 2
    sub = S("dg3", fontSize=7.3, leading=9.6, textColor=MUTED)
    col3_sub_x = 70
    for i, (n, s_) in enumerate(plats):
        py = base + h - i * (ph_ + gap) - ph_
        rrect(c, col3_x, py, col3_w, ph_, r=6, fill=BG)
        text(c, n, col3_x + 11, py + ph_ / 2 - 3, "Inter-SemiBold", 8.2, NAVY)
        sh = ph(s_, col3_w - col3_sub_x - 8, sub)
        para(d, s_, col3_x + col3_sub_x, py + ph_ / 2 + sh / 2, col3_w - col3_sub_x - 8, sub)
        arrow(c, col2_x + col2_w + 4, mid, col3_x - 5, py + ph_ / 2, SOFT, 0.8, 2.6)
    d.mark(base)
    return base


# ----------------------------------------------------------------------------
# Page 3 — V1 features
# ----------------------------------------------------------------------------
def page_features(d: Doc):
    interior_page(d, "02", "V1 features")
    c = d.c
    y = section_head(
        d, "02", "V1 features and functionality",
        "What version one will do.",
        "Version one focuses on accurate order entry, clear ownership and controlled "
        "changes. Each feature is confirmed against your workflow during discovery.")
    y -= 22

    entry = [
        "Secure employee accounts",
        "Employee and manager/admin roles",
        "Shopify product and variant lookup",
        "Customer, quantity, address and payment details",
        "Phone and WhatsApp order-source attribution",
        "Shopify order creation after validation",
        "Employee access to permitted records",
    ]
    mgr = [
        "Team-wide order counts and order values",
        "Filters by date, employee and status",
        "Payment, fulfilment and exception visibility",
        "Manager approval for high-risk changes and cancellations",
    ]
    gw = (CW - 16) / 2
    pad = 18
    st = ST["small_ink"]
    h1 = 40 + bullets_h(entry, gw - pad * 2, st, 5)
    h2 = 40 + bullets_h(mgr, gw - pad * 2, st, 5)
    ch = max(h1, h2) + pad
    for i, (title, items, tag) in enumerate([
        ("Order entry and employee accounts", entry, "FOR THE ORDER TEAM"),
        ("Manager dashboard", mgr, "FOR MANAGERS AND ADMINS"),
    ]):
        x = ML + i * (gw + 16)
        rrect(c, x, y - ch, gw, ch, r=8, stroke=RULE, fill=white)
        c.setFillColor(TEAL)
        c.rect(x + pad, y - 3, 22, 2.2, stroke=0, fill=1)
        tracked(c, tag, x + pad, y - 18, "Inter-SemiBold", 6.6, TEAL, 1.2)
        para(d, title, x + pad, y - 24, gw - pad * 2, ST["h2"])
        bullets(d, items, x + pad, y - 46, gw - pad * 2, st, 5, marker="check")
    y -= ch + 24

    # permissions matrix
    y -= sub_head(d, "Permissions and approvals", ML, y, CW)
    y -= 2
    para(d, "Roles keep routine work fast and sensitive changes controlled. Every permitted "
            "edit is written to an audit log showing who changed what, and when.",
         ML, y, CW - 40, ST["body_m"])
    y -= 30

    def P(t, s="td"):
        return Paragraph(t, ST[s] if isinstance(s, str) else s)

    ok = "<font color='#0E8577'>✓</font>&nbsp; "
    ap = "<font color='#9A6A12'>●</font>&nbsp; "
    no = "<font color='#B0453A'>×</font>&nbsp; "
    data = [
        [P("ACTION", "th"), P("EMPLOYEE", "th"), P("MANAGER / ADMIN", "th")],
        [P("Create, review and submit orders", "td_b"), P(ok + "Permitted"), P(ok + "Permitted")],
        [P("View order records", "td_b"), P(ok + "Own and permitted records"),
         P(ok + "All team records")],
        [P("Correct customer contact or address details (before fulfilment)", "td_b"),
         P(ok + "Permitted, with audit log"), P(ok + "Permitted, with audit log")],
        [P("Change product, quantity or price", "td_b"), P(ap + "Request, needs manager approval"),
         P(ok + "Approve or reject")],
        [P("Cancel an order", "td_b"), P(ap + "Request, needs manager approval"),
         P(ok + "Approve or reject")],
        [P("Override verified payment or carrier status", "td_b"), P(no + "Not permitted"),
         P("Set only by verified provider or payment data; exceptions are reviewed, "
           "not overwritten", "td_m")],
        [P("Export reports", "td_b"), P(ok + "Authorized records only"),
         P(ok + "Team-wide records")],
    ]
    cw = [CW * 0.40, CW * 0.29, CW * 0.31]
    cmds = [
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 6.2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6.2),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("BACKGROUND", (0, 0), (-1, 0), BG),
        ("LINEBELOW", (0, 0), (-1, -1), 0.5, RULE),
        ("LINEABOVE", (0, 0), (-1, 0), 0.5, RULE),
        ("TOPPADDING", (0, 0), (-1, 0), 6),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 6),
    ]
    y -= table(d, data, cw, ML, y, cmds)
    y -= 12
    # legend
    lx = ML
    for sym, col, lab in [("✓", TEAL, "Permitted"), ("●", AMBER, "Manager approval workflow"),
                          ("×", HexColor("#B0453A"), "Not permitted")]:
        text(c, sym, lx, y - 8, "Inter-SemiBold", 8, col)
        text(c, lab, lx + 11, y - 8, "Inter", 7.6, MUTED)
        lx += 22 + pdfmetrics.stringWidth(lab, "Inter", 7.6) + 6
    d.mark(y - 10)
    d.check_page("features")
    c.showPage()


# ----------------------------------------------------------------------------
# Page 4 — Operational workflow + status model
# ----------------------------------------------------------------------------
def page_workflow(d: Doc):
    interior_page(d, "03", "Operational workflow")
    c = d.c
    y = section_head(
        d, "03", "Integrations and operational workflow",
        "From conversation to delivery.",
        "Every order follows the same five steps. The Order Desk coordinates the work, "
        "while Shopify, Razorpay and Shiprocket remain the sources of truth for what they own.")
    y -= 24

    steps = [
        ("Enter and review", "The employee selects products and variants, adds customer, "
         "quantity, address and payment details, tags the source as phone or WhatsApp, and "
         "reviews the order before submitting.", ["Order Desk"]),
        ("Create in Shopify", "After validation and duplicate checks, the order is created in "
         "Shopify with the employee and source attribution recorded against it.",
         ["Shopify Admin API"]),
        ("Collect payment", "Payment follows the selected path: a Razorpay payment, a verified "
         "bank transfer, or cash on delivery. Payment status is updated only from verified data.",
         ["Razorpay", "Verified transfer", "COD"]),
        ("Track shipment", "Supported Shiprocket events update shipping and delivery status, "
         "so the team can see where each order stands.", ["Shiprocket"]),
        ("Review and report", "Managers review exceptions and approvals, filter the dashboard "
         "and export reports in Excel or CSV.", ["Manager dashboard"]),
    ]
    num_x = ML + 12
    tx = ML + 40
    tw = 300
    chip_x = ML + 360
    gap = 11
    heights = []
    for t, b, _ in steps:
        heights.append(ph(t, tw, ST["h3"]) + 3 + ph(b, tw, ST["small"]))
    # vertical rail
    total = sum(heights) + gap * (len(steps) - 1)
    c.setStrokeColor(RULE)
    c.setLineWidth(1)
    c.line(num_x, y - 10, num_x, y - total + heights[-1] - 10)
    for i, (t, b, chips) in enumerate(steps):
        c.setFillColor(NAVY if i != 2 else NAVY)
        c.circle(num_x, y - 9, 10, stroke=0, fill=1)
        text(c, str(i + 1), num_x, y - 12, "Inter-SemiBold", 8.4, white, align="center")
        hh = para(d, t, tx, y - 2, tw, ST["h3"])
        para(d, b, tx, y - 2 - hh - 3, tw, ST["small"])
        cx = chip_x
        cyy = y - 15
        for ch in chips:
            wch = pdfmetrics.stringWidth(ch, "Inter-SemiBold", 7.2) + 11
            if cx + wch > W - MR:
                cx = chip_x
                cyy -= 17
            cx += chip(c, ch, cx, cyy) + 5
        y -= heights[i] + gap
    y -= 14

    # status model
    y -= sub_head(d, "Five statuses, always kept distinct", ML, y, CW)
    y -= 2
    para(d, "An order can be created but unpaid, or paid but not yet shipped. Keeping each "
            "status separate keeps dashboards and reports unambiguous.",
         ML, y, CW, ST["body_m"])
    y -= 32

    def P(t, s="td"):
        return Paragraph(t, ST[s] if isinstance(s, str) else s)

    data = [
        [P("STATUS", "th"), P("WHAT IT TRACKS", "th"), P("SOURCE OF TRUTH", "th")],
        [P("Order status", "td_b"), P("Whether the order is in review, created in Shopify, "
                                      "awaiting approval or cancelled"),
         P("Order Desk and Shopify", "td_m")],
        [P("Payment status", "td_b"), P("Whether payment is pending, paid or cash on "
                                        "delivery"),
         P("Verified Razorpay data, verified transfers, COD workflow", "td_m")],
        [P("Shipment status", "td_b"), P("Movement from pickup through delivery, plus "
                                         "delivery exceptions"),
         P("Supported Shiprocket events", "td_m")],
        [P("Return status", "td_b"), P("Returns and return-to-origin (RTO) progress"),
         P("Supported Shiprocket events and Shopify records", "td_m")],
        [P("Refund status", "td_b"), P("Whether a refund has been initiated or completed"),
         P("Payment provider and Shopify records, where available", "td_m")],
    ]
    cw = [CW * 0.22, CW * 0.44, CW * 0.34]
    cmds = [
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5.6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5.6),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("BACKGROUND", (0, 0), (-1, 0), BG),
        ("LINEBELOW", (0, 0), (-1, -1), 0.5, RULE),
        ("LINEABOVE", (0, 0), (-1, 0), 0.5, RULE),
        ("TOPPADDING", (0, 0), (-1, 0), 6),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 6),
    ]
    y -= table(d, data, cw, ML, y, cmds)
    d.check_page("workflow")
    c.showPage()


# ----------------------------------------------------------------------------
# Page 5 — Technology and integration qualifications
# ----------------------------------------------------------------------------
def page_tech(d: Doc):
    interior_page(d, "04", "Technology")
    c = d.c
    y = section_head(
        d, "04", "Technology and integration safeguards",
        "Built on the platforms you already use.",
        "A secure web application that connects to Shopify, Razorpay and Shiprocket "
        "through their official server-side interfaces. Employees need only a modern browser.")
    y -= 22

    y = arch_diagram(d, y)
    y -= 20

    # components table (two-up list)
    y -= sub_head(d, "The technology, in plain terms", ML, y, CW)
    comps = [
        ("Secure web application", "Sign-in, order entry and dashboards in the browser."),
        ("Server-side integration APIs", "All provider credentials and calls stay on the "
                                         "server, never in the browser."),
        ("Operational database", "Employee access, order records, audit history and "
                                 "reconciliation references."),
        ("Shopify Admin API", "Product and variant lookup and validated order creation."),
        ("Razorpay APIs and webhooks", "Payment links and verified payment events, where "
                                       "supported."),
        ("Shiprocket APIs and webhooks", "Shipment and delivery updates, where supported "
                                         "for your account."),
        ("Safeguards", "Role-based access, duplicate protection and clear error handling, "
                       "with failed actions surfaced for review."),
    ]
    gw = (CW - 22) / 2
    rows = (len(comps) + 1) // 2
    for r in range(rows):
        hs = []
        for col in range(2):
            i = r * 2 + col
            if i < len(comps):
                hs.append(ph(comps[i][0], gw, ST["card_t"]) + 2 + ph(comps[i][1], gw,
                                                                    ST["card_b"]))
        rh = max(hs)
        for col in range(2):
            i = r * 2 + col
            if i < len(comps):
                x = ML + col * (gw + 22)
                hh = para(d, comps[i][0], x, y, gw, ST["card_t"])
                para(d, comps[i][1], x, y - hh - 2, gw, ST["card_b"])
        y -= rh + 9
    y -= 10

    # qualifications panel
    quals = [
        "Razorpay payment links do not automatically guarantee that Shopify’s financial "
        "status will update. We will confirm the supported way to record a verified payment "
        "against the correct Shopify order.",
        "We will validate API permissions, webhook availability and transaction "
        "verification for each provider before build.",
        "We will confirm which Shiprocket events are available on your account before "
        "committing to specific shipping, NDR, RTO or reverse-shipment automation.",
        "Fully automatic bank reconciliation is not part of this proposal. Bank transfers "
        "follow a verified, reviewable workflow.",
    ]
    pad = 18
    inner = CW - pad * 2 - 4
    qh = 40 + bullets_h(quals, inner, ST["small_ink"], 5) + 34
    rrect(c, ML, y - qh, CW, qh, r=8, fill=AMBER_L)
    c.setFillColor(AMBER)
    c.rect(ML, y - qh + 8, 2.6, qh - 16, stroke=0, fill=1)
    tracked(c, "INTEGRATION QUALIFICATIONS", ML + pad + 4, y - 20, "Inter-SemiBold", 6.8,
            AMBER, 1.2)
    para(d, "Only capabilities verified during technical discovery will be implemented.",
         ML + pad + 4, y - 26, inner, ST["h3"])
    by = y - 46
    bh = bullets(d, quals, ML + pad + 4, by, inner, ST["small_ink"], 5, marker="dot",
                 color=AMBER)
    para(d, "Any capability that cannot be verified will be documented with a practical "
            "alternative before build continues.", ML + pad + 4, by - bh - 9, inner,
         S("qn", fontName="Serif-Italic", fontSize=8.8, leading=12.5, textColor=MUTED))
    d.mark(y - qh)
    d.check_page("tech")
    c.showPage()


def arch_diagram(d: Doc, y: float) -> float:
    c = d.c
    h = 138
    base = y - h
    rrect(c, ML, base, CW, h, r=10, fill=BG)
    # left: users
    ux = ML + 18
    users = [("Employees", "own and permitted records"), ("Managers / admins",
                                                          "team-wide view and approvals")]
    for i, (n, s) in enumerate(users):
        uy = base + h - 42 - i * 50
        rrect(c, ux, uy - 14, 112, 36, r=6, fill=white, stroke=RULE)
        text(c, n, ux + 10, uy + 9, "Inter-SemiBold", 8, NAVY)
        text(c, s, ux + 10, uy - 3, "Inter", 6.8, MUTED)
    text(c, "Browser, HTTPS sign-in", ux, base + 16, "Inter", 6.8, SOFT)
    # middle: app + integration layer + db
    mx = ML + 150
    mw = 160
    rrect(c, mx, base + 14, mw, h - 28, r=8, fill=NAVY)
    tracked(c, "ORDER DESK  ·  PROPOSED", mx + 12, base + h - 30, "Inter-SemiBold", 6.2,
            TEAL_ON_DARK, 1.1)
    layers = ["Web application", "Server-side integration layer", "Database and audit log"]
    ly = base + h - 40
    for i, l in enumerate(layers):
        rrect(c, mx + 12, ly - 21, mw - 24, 21, r=4, fill=NAVY_2)
        text(c, l, mx + 22, ly - 13.6, "Inter-Medium", 7.6, white)
        ly -= 27
    for i in range(2):
        uy = base + h - 42 - i * 50 + 4
        arrow(c, ux + 114, uy, mx - 4, base + h / 2 + 8 - i * 16, SOFT, 0.8, 2.4)
    # right: providers
    px = ML + 338
    pw = CW - 338 - 14
    provs = [("Shopify Admin API", "products, variants, orders"),
             ("Razorpay APIs + webhooks", "payments, where supported"),
             ("Shiprocket APIs + webhooks", "shipments, where supported")]
    for i, (n, s) in enumerate(provs):
        py = base + h - 42 - i * 39
        rrect(c, px, py - 11, pw, 32, r=6, fill=white, stroke=RULE)
        text(c, n, px + 10, py + 8, "Inter-SemiBold", 7.8, NAVY)
        text(c, s, px + 10, py - 3.5, "Inter", 6.8, MUTED)
        # two-way connector
        yy = py + 5
        arrow(c, mx + mw + 4, base + h / 2 - 6, px - 4, yy, SOFT, 0.8, 2.4)
    d.mark(base)
    return base


# ----------------------------------------------------------------------------
# Page 6 — Dashboards and reporting
# ----------------------------------------------------------------------------
def page_reporting(d: Doc):
    interior_page(d, "05", "Reporting")
    c = d.c
    y = section_head(
        d, "05", "Dashboards, reporting and downloads",
        "A clear view for every role.",
        "Two views of the same reliable data: a focused workspace for each employee and a "
        "complete overview for managers.")
    y -= 22

    emp = ["Orders the employee has entered or is permitted to see",
           "Payment and shipment status for each of those orders",
           "Pending approvals they have requested",
           "Exports limited to records they are authorized to access"]
    mgr = ["Team-wide order overview",
           "Employee-wise order counts and order values",
           "Payment, fulfilment and exception queues",
           "Approvals for product, quantity, price changes and cancellations",
           "Team-wide exports for any date range"]
    gw = (CW - 16) / 2
    pad = 18
    st = ST["small_ink"]
    hh = max(bullets_h(emp, gw - pad * 2, st, 5), bullets_h(mgr, gw - pad * 2, st, 5)) + 58
    for i, (title, tag, items, dark) in enumerate([
        ("Employee view", "INDIVIDUAL", emp, False),
        ("Manager view", "TEAM-WIDE", mgr, True),
    ]):
        x = ML + i * (gw + 16)
        rrect(c, x, y - hh, gw, hh, r=8, fill=NAVY if dark else BG)
        tracked(c, tag, x + pad, y - 20, "Inter-SemiBold", 6.6,
                TEAL_ON_DARK if dark else TEAL, 1.2)
        para(d, title, x + pad, y - 26, gw - pad * 2,
             S("rv", fontName="Inter-SemiBold", fontSize=11.2, leading=15,
               textColor=white if dark else NAVY))
        bullets(d, items, x + pad, y - 50, gw - pad * 2,
                S("rvb", fontSize=8.4, leading=12.4, textColor=ON_DARK if dark else INK),
                5, marker="dash", color=TEAL_ON_DARK if dark else TEAL)
    y -= hh + 24

    y -= sub_head(d, "Report catalogue", ML, y, CW)
    y -= 2

    def P(t, s="td"):
        return Paragraph(t, ST[s] if isinstance(s, str) else s)

    data = [
        [P("REPORT", "th"), P("WHAT IT INCLUDES", "th"), P("WHO CAN EXPORT", "th")],
        [P("Detailed orders", "td_b"), P("Order-level detail: products, customer, source, "
                                         "employee, values and current statuses"),
         P("Employees (authorized records); managers (team)", "td_m")],
        [P("Employee performance", "td_b"), P("Order counts and order values by employee "
                                              "and period"),
         P("Managers / admins", "td_m")],
        [P("Payments", "td_b"), P("Paid, pending, COD and refund reporting, where supported "
                                  "by source data"),
         P("Managers / admins", "td_m")],
        [P("Shipping and delivery", "td_b"), P("Shipment progress, delivered orders and "
                                               "delivery exceptions"),
         P("Employees (authorized records); managers (team)", "td_m")],
        [P("Cancellations, returns and RTO", "td_b"), P("Cancelled orders, returns and "
                                                        "return-to-origin activity"),
         P("Managers / admins", "td_m")],
        [P("Exceptions", "td_b"), P("Orders needing attention, such as failed creation, "
                                    "payment mismatches or delivery issues"),
         P("Managers / admins", "td_m")],
    ]
    cw = [CW * 0.27, CW * 0.45, CW * 0.28]
    cmds = [
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5.4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5.4),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("BACKGROUND", (0, 0), (-1, 0), BG),
        ("LINEBELOW", (0, 0), (-1, -1), 0.5, RULE),
        ("LINEABOVE", (0, 0), (-1, 0), 0.5, RULE),
        ("TOPPADDING", (0, 0), (-1, 0), 6),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 6),
    ]
    y -= table(d, data, cw, ML, y, cmds)
    y -= 20

    # filters & formats strip
    sh = 62
    rrect(c, ML, y - sh, CW, sh, r=8, stroke=RULE, fill=white)
    tracked(c, "FILTERS", ML + 16, y - 20, "Inter-SemiBold", 6.6, MUTED, 1.2)
    cx = ML + 16
    for f in ["Date range", "Employee", "Order status", "Payment status", "Shipment status"]:
        cx += chip(c, f, cx, y - 46, fill=BG, color=NAVY) + 5
    fx = ML + CW - 150
    c.setStrokeColor(RULE)
    c.line(fx - 16, y - 12, fx - 16, y - sh + 12)
    tracked(c, "DOWNLOAD FORMATS", fx, y - 20, "Inter-SemiBold", 6.6, MUTED, 1.2)
    x2 = fx
    for f in ["Excel (.xlsx)", "CSV"]:
        x2 += chip(c, f, x2, y - 46) + 5
    d.mark(y - sh)
    y -= sh + 12
    para(d, "Report contents depend on the data each provider makes available to your "
            "account.",
         ML, y, CW, ST["tiny"])
    d.check_page("reporting")
    c.showPage()


# ----------------------------------------------------------------------------
# Page 7 — Quotation and subscription
# ----------------------------------------------------------------------------
def inr(n: int) -> str:
    s = str(n)
    if len(s) <= 3:
        return "₹" + s
    head, tail = s[:-3], s[-3:]
    parts = []
    while len(head) > 2:
        parts.insert(0, head[-2:])
        head = head[:-2]
    if head:
        parts.insert(0, head)
    return "₹" + ",".join(parts + [tail])


def page_quote(d: Doc):
    interior_page(d, "06", "Investment")
    c = d.c
    y = section_head(d, "06", "Itemized quotation",
                     "A clear, fixed investment.")
    y -= 20

    # three summary cards
    cards = [
        ("1", "ONE-TIME IMPLEMENTATION", SETUP_FEE, "", "Design, configuration, integration, "
         "testing and deployment of the agreed V1 system.", True),
        ("2", "MONTHLY SAAS SUBSCRIPTION", MONTHLY_FEE, "/ month", "Software access, hosting, "
         "operation, support and bug resolution.", False),
        ("3", "TAXES AND THIRD-PARTY CHARGES", "Additional", "", "Applied where applicable, "
         "in addition to the fees above.", False),
    ]
    gw = (CW - 24) / 3
    chh = 94
    for i, (n, lab, val, suf, desc, dark) in enumerate(cards):
        x = ML + i * (gw + 12)
        rrect(c, x, y - chh, gw, chh, r=8, fill=NAVY if dark else BG)
        tracked(c, lab, x + 14, y - 20, "Inter-SemiBold", 6.2,
                TEAL_ON_DARK if dark else TEAL, 0.9)
        vs = 23 if val.startswith("₹") else 19
        text(c, val, x + 14, y - 46, "Serif-Light" if val.startswith("₹") else "Serif", vs,
             white if dark else NAVY)
        if suf:
            vw = pdfmetrics.stringWidth(val, "Serif-Light", vs)
            text(c, suf, x + 14 + vw + 4, y - 46, "Inter", 8.4, MUTED)
        para(d, desc, x + 14, y - 58, gw - 28,
             S("qc", fontSize=7.8, leading=11.2, textColor=ON_DARK if dark else MUTED))
    d.mark(y - chh)
    y -= chh + 20

    # implementation allocation table
    y -= sub_head(d, "How the ₹25,000 implementation fee is allocated", ML, y, CW)
    y -= 2
    y -= para(d, "A single fixed fee, allocated below across the work needed to deliver the "
                 "agreed V1 system. These amounts are an allocation of Reygent AI’s fee, not "
                 "independently measured vendor costs or third-party expenses.", ML, y, CW,
              ST["body_m"])
    y -= 14

    # proportion bar
    total = sum(w[2] for w in WORKSTREAMS)
    shades = [HexColor(h) for h in ("#0B1F35", "#14304D", "#1E4A6E", "#0E8577", "#3AA597",
                                    "#7CC5BA", "#B9DFD8")]
    bx = ML
    for i, (_, _, amt) in enumerate(WORKSTREAMS):
        bw = CW * amt / total
        c.setFillColor(shades[i])
        c.rect(bx, y - 6, bw - (1.2 if i < len(WORKSTREAMS) - 1 else 0), 6, stroke=0, fill=1)
        bx += bw
    y -= 16

    def P(t, s="td"):
        return Paragraph(t, ST[s] if isinstance(s, str) else s)

    rows = [[P("", "th"), P("WORKSTREAM AND WHY IT IS REQUIRED", "th"),
             P("ALLOCATION", "th")]]
    for i, (t, why, amt) in enumerate(WORKSTREAMS):
        rows.append([
            P(f"<font color='#0E8577'>{i + 1:02d}</font>", "td_b"),
            P(f"<font name='Inter-SemiBold' color='#0B1F35'>{t}</font><br/>"
              f"<font size='8' color='#56636F'>{why}</font>",
              S("wt", fontSize=8.6, leading=12)),
            P(inr(amt), "td_r"),
        ])
    rows.append([P(""), P("<font name='Inter-SemiBold'>Total one-time implementation fee"
                          "</font>", S("tt", fontSize=9.2, leading=12, textColor=white)),
                 P(inr(total), S("ttr", fontName="Inter-Bold", fontSize=10.5, leading=13,
                                 textColor=white, alignment=TA_RIGHT))])
    cw = [34, CW - 34 - 84, 84]
    n = len(rows)
    cmds = [
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("VALIGN", (0, 1), (0, -2), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 5.2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5.6),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("LINEBELOW", (0, 0), (-1, -2), 0.5, RULE),
        ("BACKGROUND", (0, n - 1), (-1, n - 1), NAVY),
        ("TOPPADDING", (0, n - 1), (-1, n - 1), 9),
        ("BOTTOMPADDING", (0, n - 1), (-1, n - 1), 9),
        ("TOPPADDING", (0, 0), (-1, 0), 2),
    ]
    th = table(d, rows, cw, ML, y, cmds)
    y -= th + 12
    para(d, "The fee covers the design, configuration, integration work, permissions, testing "
            "and deployment required to deliver the agreed V1 system. Taxes are additional, "
            "where applicable.", ML, y, CW, ST["small"])
    d.check_page("quote")
    c.showPage()


# ----------------------------------------------------------------------------
# Page 8 — Subscription, scope boundaries
# ----------------------------------------------------------------------------
def page_subscription(d: Doc):
    interior_page(d, "07", "Subscription")
    c = d.c
    y = section_head(d, "07", "Monthly subscription and scope boundaries",
                     f"What {MONTHLY_FEE} a month covers.",
                     "The subscription keeps the agreed Order Desk running, supported and "
                     "working as specified after go-live.")
    y -= 22

    inc = [
        ("Software access", "Use of the agreed Order Desk software by your team."),
        ("Hosting and operation", "Hosting and routine operation of the agreed system."),
        ("Support and troubleshooting", "Technical support and troubleshooting when your "
                                        "team needs help."),
        ("Bug and error resolution", "Fixes for bugs and errors within the agreed "
                                     "functionality."),
    ]
    gw = (CW - 14) / 2
    hs = [ph(t, gw - 52, ST["card_t"]) + 3 + ph(b, gw - 52, ST["card_b"]) for t, b in inc]
    rh = max(hs) + 30
    for i, (t, b) in enumerate(inc):
        r, col = divmod(i, 2)
        x = ML + col * (gw + 14)
        yy = y - r * (rh + 12)
        rrect(c, x, yy - rh, gw, rh, r=8, fill=BG)
        c.setFillColor(TEAL)
        c.circle(x + 26, yy - 26, 9.5, stroke=0, fill=1)
        c.setStrokeColor(white)
        c.setLineWidth(1.4)
        c.setLineCap(1)
        c.setLineJoin(1)
        p = c.beginPath()
        p.moveTo(x + 21.6, yy - 26)
        p.lineTo(x + 24.8, yy - 29.2)
        p.lineTo(x + 30.6, yy - 22.4)
        c.drawPath(p, stroke=1, fill=0)
        hh = para(d, t, x + 46, yy - 16, gw - 60, ST["card_t"])
        para(d, b, x + 46, yy - 16 - hh - 3, gw - 60, ST["card_b"])
    y -= 2 * rh + 12 + 28

    # Not included
    y -= sub_head(d, "Outside the subscription", ML, y, CW)
    outside = [
        "<b>New features, custom development and changes beyond the agreed scope</b> are "
        "quoted separately before any work begins.",
        "<b>Third-party charges</b>, such as Shopify plan fees, Razorpay transaction fees "
        "and Shiprocket shipping charges, are billed by those providers.",
        "<b>Provider outages and limitations</b> remain subject to each provider’s own terms "
        "and capabilities. We will help diagnose impact on the Order Desk.",
    ]
    y -= bullets(d, outside, ML, y, CW - 20, ST["body"], 7, marker="dash")
    y -= 28

    # scope boundaries for V1
    y -= sub_head(d, "V1 scope boundaries", ML, y, CW)
    gw2 = (CW - 22) / 2
    inn = ["Shopify-connected order entry, attribution and permissions",
           "Razorpay, verified-transfer and COD payment workflows",
           "Supported Shiprocket status updates",
           "Manager dashboard, reports and Excel/CSV exports"]
    outn = ["Replacing Shopify, Razorpay or Shiprocket",
            "Fully automatic bank reconciliation",
            "Integrations or automations not verified in discovery",
            "Native mobile apps (V1 is a responsive web application)"]
    tracked(c, "INCLUDED IN V1", ML, y - 8, "Inter-SemiBold", 6.6, TEAL, 1.2)
    tracked(c, "NOT INCLUDED IN V1", ML + gw2 + 22, y - 8, "Inter-SemiBold", 6.6,
            HexColor("#B0453A"), 1.2)
    h1 = bullets(d, inn, ML, y - 18, gw2, ST["small_ink"], 5, marker="check")
    h2 = bullets(d, outn, ML + gw2 + 22, y - 18, gw2, ST["small_ink"], 5, marker="cross",
                 color=HexColor("#B0453A"))
    y -= 18 + max(h1, h2) + 26

    # note panel
    nh = 50
    rrect(c, ML, y - nh, CW, nh, r=8, fill=TEAL_L)
    para(d, "<font name='Inter-SemiBold' color='#0A6E63'>Changes after sign-off.</font> "
            "If priorities shift during or after implementation, Reygent AI will describe the "
            "change, its effect on delivery and its cost in writing. Work proceeds only once "
            "you approve.", ML + 16, y - 12, CW - 32,
         S("cn", fontSize=8.6, leading=12.8, textColor=INK))
    d.mark(y - nh)
    d.check_page("subscription")
    c.showPage()


# ----------------------------------------------------------------------------
# Page 9 — Delivery plan, client inputs and acceptance
# ----------------------------------------------------------------------------
def page_delivery(d: Doc):
    interior_page(d, "08", "Delivery and next steps")
    c = d.c
    y = section_head(d, "08", "Delivery plan and next steps",
                     f"Live in an estimated {DELIVERY_WINDOW}.",
                     "The delivery window begins once discovery is confirmed and the required "
                     "system access has been provided.")
    y -= 26

    # timeline
    phases = [
        ("Discovery", "Workflow, roles and API access validated", 0.0, 1.0),
        ("Build", "Interface, accounts, permissions, audit log", 0.75, 2.25),
        ("Integrate", "Shopify, payment workflows, Shiprocket", 1.5, 3.0),
        ("Test and accept", "End-to-end testing and your acceptance", 2.5, 3.5),
        ("Go-live", "Deployment, walkthrough and handover", 3.25, 4.0),
    ]
    lab_w = 190
    gx = ML + lab_w
    gw = CW - lab_w
    weeks = 4
    # week header
    for wk in range(weeks):
        x = gx + gw * wk / weeks
        tracked(c, f"WEEK {wk + 1}", x + 6, y - 8, "Inter-SemiBold", 6.4, MUTED, 1.1)
        c.setStrokeColor(RULE)
        c.setLineWidth(0.5)
        c.line(x, y, x, y - 18 - len(phases) * 32 + 6)
    c.line(gx + gw, y, gx + gw, y - 18 - len(phases) * 32 + 6)
    yy = y - 22
    for i, (t, sub, s, e) in enumerate(phases):
        text(c, t, ML, yy - 9, "Inter-SemiBold", 8.6, NAVY)
        text(c, sub, ML, yy - 20.5, "Inter", 7.3, MUTED)
        bx = gx + gw * s / weeks + 2
        bw = gw * (e - s) / weeks - 4
        rrect(c, bx, yy - 17, bw, 12, r=6, fill=NAVY if i < 4 else TEAL)
        yy -= 32
    d.mark(yy)
    y = yy - 6
    para(d, "Indicative schedule. Final dates are confirmed at the end of discovery and depend "
            "on access, provider verification and timely feedback.", ML, y, CW, ST["tiny"])
    y -= 34

    # client inputs + next steps two columns
    gw2 = (CW - 24) / 2
    top = y
    h1 = sub_head(d, "What we will need from Magic in Home", ML, top, gw2)
    inputs = ["Shopify admin access to approve the custom app and API permissions",
              "Razorpay and Shiprocket API credentials and account access",
              "Employee list, roles and approval rules",
              "A nominated contact for workflow decisions and acceptance testing"]
    b1 = bullets(d, inputs, ML, top - h1, gw2, ST["small_ink"], 5, marker="dash")
    x2 = ML + gw2 + 24
    h2 = sub_head(d, "Next steps", x2, top, gw2)
    steps = ["Review this proposal and confirm the V1 scope",
             "Sign the acceptance below and the service agreement",
             "Provide system access and schedule the discovery session",
             "Reygent AI confirms the delivery plan and begins build"]
    sy = top - h2
    for i, s in enumerate(steps):
        text(c, f"{i + 1}", x2 + 4, sy - 8.6, "Inter-SemiBold", 8.4, TEAL, align="center")
        sh = para(d, s, x2 + 16, sy, gw2 - 16, ST["small_ink"])
        sy -= sh + 5
    y = min(top - h1 - b1, sy) - 26

    # commercial recap + acceptance
    rh = 30
    rrect(c, ML, y - rh, CW, rh, r=6, fill=BG)
    recap = (f"<font name='Inter-SemiBold' color='#0B1F35'>Summary</font>"
             f"&nbsp;&nbsp;·&nbsp;&nbsp;Implementation <b>{SETUP_FEE}</b> one-time"
             f"&nbsp;&nbsp;·&nbsp;&nbsp;Subscription <b>{MONTHLY_FEE}/month</b>"
             f"&nbsp;&nbsp;·&nbsp;&nbsp;Taxes and third-party charges extra")
    para(d, recap, ML + 14, y - 9, CW - 28, S("rc", fontSize=8.2, leading=12, textColor=INK))
    y -= rh + 16

    y -= para(d, f"Billing schedule and payment terms will be set out in the service "
                 f"agreement. This proposal is valid for {VALIDITY}.",
              ML, y, CW, ST["tiny"])
    y -= 24

    sw = (CW - 30) / 2
    for i, who in enumerate([f"For {CLIENT}", f"For {PROVIDER}"]):
        x = ML + i * (sw + 30)
        tracked(c, who.upper(), x, y, "Inter-SemiBold", 6.8, TEAL, 1.2)
        for j, lab in enumerate(["Name and title", "Signature", "Date"]):
            ly = y - 30 - j * 30
            hline(c, x, x + sw, ly, HexColor("#AAB4BE"), 0.6)
            text(c, lab, x, ly - 10, "Inter", 6.8, SOFT)
    d.mark(y - 30 - 2 * 30 - 12)
    d.check_page("delivery")
    c.showPage()


# ----------------------------------------------------------------------------
def build(path: str = OUT) -> list[str]:
    d = Doc(path)
    d.total = 9
    page_cover(d)
    page_exec(d)
    page_features(d)
    page_workflow(d)
    page_tech(d)
    page_reporting(d)
    page_quote(d)
    page_subscription(d)
    page_delivery(d)
    d.c.save()
    return d.warnings


if __name__ == "__main__":
    warns = build()
    for w in warns:
        print("LAYOUT WARNING:", w, file=sys.stderr)
    print(f"Wrote {OUT}")
    sys.exit(1 if warns else 0)
