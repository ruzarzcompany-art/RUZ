"""يضع مفتاح الربط في config.json دون تعديل الملف يدوياً."""
import json, pathlib, sys

path = pathlib.Path(__file__).with_name("config.json")
cfg = json.loads(path.read_text(encoding="utf-8"))
print("الصق مفتاح الربط (كليك يمين في هذه النافذة) ثم اضغط Enter:")
key = input("> ").strip().strip('"').strip()
if len(key) < 8:
    print("المفتاح قصير أو فارغ — لم يتغير شيء.")
    sys.exit(1)
cfg["agentKey"] = key
path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
print("تم حفظ المفتاح. طوله", len(key), "حرفاً.")
