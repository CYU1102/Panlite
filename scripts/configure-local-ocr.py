"""Configure only PanLite's local OCR paths, keeping unrelated settings intact."""
import argparse
import json
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--tesseract', type=Path, required=True)
    parser.add_argument('--pdftoppm', type=Path, required=True)
    parser.add_argument('--backup', type=Path, required=True)
    parser.add_argument('--language', default='chi_sim+eng')
    args = parser.parse_args()
    database = args.database.resolve(strict=True)
    tesseract = args.tesseract.resolve(strict=True)
    pdftoppm = args.pdftoppm.resolve(strict=True)
    if not database.is_file() or not tesseract.is_file() or not pdftoppm.is_file():
        raise ValueError('Database and executables must be existing files')
    with sqlite3.connect(database.as_uri() + '?mode=rw', uri=True, timeout=15) as connection:
        connection.execute('BEGIN IMMEDIATE')
        row = connection.execute('SELECT value FROM settings WHERE key = ?', ('aiLocalToolsV1',)).fetchone()
        existing = json.loads(row[0]) if row else {}
        if not isinstance(existing, dict):
            raise ValueError('Existing local tool settings are malformed; refusing to overwrite')
        updated = dict(existing, tesseractPath=str(tesseract), pdftoppmPath=str(pdftoppm), ocrLanguage=args.language)
        args.backup.parent.mkdir(parents=True, exist_ok=True)
        # Never replace a previous backup; this record contains only local tool paths.
        with args.backup.open('x', encoding='utf-8') as output:
            json.dump({'createdAt': datetime.now(timezone.utc).isoformat(), 'database': str(database),
                       'key': 'aiLocalToolsV1', 'previousValue': row[0] if row else None}, output, ensure_ascii=False, indent=2)
        connection.execute("INSERT INTO settings (key, value, encrypted, updated_at) VALUES (?, ?, 0, ?) "
                           "ON CONFLICT(key) DO UPDATE SET value=excluded.value, encrypted=0, updated_at=excluded.updated_at",
                           ('aiLocalToolsV1', json.dumps(updated, ensure_ascii=False), int(time.time() * 1000)))
        actual = json.loads(connection.execute('SELECT value FROM settings WHERE key = ?', ('aiLocalToolsV1',)).fetchone()[0])
        if actual != updated:
            raise RuntimeError('Local tool settings did not persist')
    print(json.dumps({'configured': True, 'database': str(database), 'localTools': updated, 'backup': str(args.backup)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
