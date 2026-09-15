"""Generate deterministic, synthetic OCR ground truth without PDF text layers."""
import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader


ENGLISH = [
    "PanLite OCR Acceptance Invoice",
    "Invoice number: INV-2026-0018",
    "Customer: Morning Light Technology",
    "Quantity: 12",
    "Unit price: 128.50",
    "Subtotal: 1542.00",
    "Tax rate: 6%",
    "Tax amount: 92.52",
    "Total amount: 1634.52",
    "Payment date: 2026-09-09",
]
CHINESE = [
    "本地文字识别验收",
    "合同编号：202609090018",
    "客户名称：上海晨光科技有限公司",
    "项目名称：网盘文件预览与文字识别",
    "采购数量：12",
    "商品单价：128.50",
    "税前金额：1542.00",
    "税费金额：92.52",
    "合计金额：1634.52",
    "付款日期：2026年09月09日",
]
MIXED = [
    "PanLite 本地识别验收",
    "合同编号：PL-2026-0909",
    "客户名称：上海晨光科技有限公司",
    "项目说明：文件在线预览与本地文字识别",
    "Invoice number: INV-2026-0018",
    "Quantity: 12",
    "Unit price: 128.50",
    "Subtotal: 1542.00",
    "Tax rate: 6%",
    "Tax amount: 92.52",
    "Total amount: 1634.52",
    "付款日期：2026-09-09",
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--font", required=True)
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    font_path = Path(args.font).resolve()
    font = ImageFont.truetype(str(font_path), 48)
    cases = [
        ("clean-english", ENGLISH, 255, 0, 1.0, 0.0, 0.02),
        ("clean-chinese", CHINESE, 255, 0, 1.0, 0.0, 0.02),
        ("scaled-mixed", MIXED, 255, 0, 0.68, 0.45, 0.05),
        ("low-contrast-mixed", MIXED, 240, 174, 1.0, 0.0, 0.08),
    ]
    manifest = {
        "schemaVersion": 1,
        "synthetic": True,
        "description": "Fixed generated ground truth; no user documents; image-only PDF pages.",
        "language": "chi_sim+eng",
        "font": str(font_path),
        "fontSha256": hashlib.sha256(font_path.read_bytes()).hexdigest(),
        "fontSize": 48,
        "numericPolicy": "Every numeric token and every two-decimal amount must match exactly in source order.",
        "thresholdPolicy": "Whitespace-insensitive CER <= predeclared case threshold; strict CER also reported. Thresholds are fixed before OCR and are not a general accuracy guarantee.",
        "cases": [],
    }
    pdf_path = output / "scanned-fixtures.pdf"
    document = canvas.Canvas(str(pdf_path), pagesize=(600, 800), invariant=1)
    for index, (name, lines, background, foreground, scale, blur, threshold) in enumerate(cases, 1):
        image = Image.new("RGB", (1800, 2400), (background,) * 3)
        draw = ImageDraw.Draw(image)
        for line_index, line in enumerate(lines):
            draw.text((100, 120 + line_index * 90), line, font=font, fill=(foreground,) * 3)
        if scale != 1:
            image = image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)
        if blur:
            image = image.filter(ImageFilter.GaussianBlur(blur))
        image_path = output / f"{name}.png"
        image.save(image_path, dpi=(300 * scale, 300 * scale))
        truth = "\n".join(lines)
        (output / f"{name}.groundtruth.txt").write_text(truth + "\n", encoding="utf-8")
        document.drawImage(ImageReader(image), 0, 0, width=600, height=800)
        document.showPage()
        manifest["cases"].append({
            "id": name,
            "pageNumber": index,
            "image": str(image_path),
            "truth": truth,
            "truthSha256": hashlib.sha256(truth.encode("utf-8")).hexdigest(),
            "imageSha256": hashlib.sha256(image_path.read_bytes()).hexdigest(),
            "width": image.width,
            "height": image.height,
            "background": background,
            "foreground": foreground,
            "scale": scale,
            "gaussianBlurRadius": blur,
            "maximumWhitespaceInsensitiveCer": threshold,
        })
    document.save()
    manifest["pdf"] = str(pdf_path)
    manifest["pdfSha256"] = hashlib.sha256(pdf_path.read_bytes()).hexdigest()
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "cases": len(cases), "pdf": str(pdf_path)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
