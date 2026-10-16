import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[3] / "apps/zcode-cli/packages/visualize-plugin/skills/visualize/scripts/vendor.py"
spec = importlib.util.spec_from_file_location("gen_ui_vendor", SOURCE)
vendor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vendor)
URL = "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"


class VendorExportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "d3.js").write_bytes(b"window.d3 = {};")
        self.manifest = {"resources": [{"url": URL, "file": "d3.js", "sha256": hashlib.sha256(b"window.d3 = {};").hexdigest()}]}
        (self.root / "manifest.json").write_text(json.dumps(self.manifest))
        patcher = patch.object(vendor, "_VENDOR", self.root)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_preserves_order_attributes_unicode_and_script_body(self):
        source = f'''中文\r\n<p>前面\u2028文字</p><script SRC='{URL}' id="lib" async onload="run('a&b')"></script><script>after()</script>'''
        result = vendor.embed_vendor_scripts(source)
        self.assertTrue(result.startswith("中文\r\n<p>前面\u2028文字</p><script "))
        self.assertIn('src="data:text/javascript;base64,', result)
        self.assertIn('id="lib" async onload="run(&#x27;a&amp;b&#x27;)"', result)
        self.assertTrue(result.endswith("</script><script>after()</script>"))

    def test_only_matches_exact_script_sources(self):
        source = f'''<!-- <script src="{URL}"></script> --><script>const url="{URL}";</script><a href="{URL}">URL</a><script src="{URL}?other=1"></script><script src="{URL.replace('7.9.0', '7.8.0')}"></script>'''
        self.assertEqual(vendor.embed_vendor_scripts(source), source)

    def test_rejects_corrupt_or_missing_files(self):
        source = f'<script src="{URL}"></script>'
        (self.root / "d3.js").write_text("tampered")
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            vendor.embed_vendor_scripts(source)
        (self.root / "d3.js").unlink()
        with self.assertRaises(FileNotFoundError):
            vendor.embed_vendor_scripts(source)


if __name__ == "__main__":
    unittest.main()
