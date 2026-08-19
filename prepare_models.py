from pathlib import Path
import shutil
import subprocess
import sys
from huggingface_hub import snapshot_download

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / 'public' / 'models'
MODELS.mkdir(parents=True, exist_ok=True)

FILES = [
    'config.json',
    'generation_config.json',
    'tokenizer_config.json',
    'special_tokens_map.json',
    'tokenizer.json',
    'source.spm',
    'target.spm',
    'vocab.json',
]


def run(cmd):
    print('+', ' '.join(map(str, cmd)), flush=True)
    subprocess.run(cmd, check=True)


def copy_tokenizer(model_id: str, out_dir: Path):
    cache = Path(snapshot_download(model_id, allow_patterns=FILES))
    for name in FILES:
        src = cache / name
        if src.exists():
            shutil.copy2(src, out_dir / name)


def prepare(model_id: str, out_dir: Path):
    out_dir.mkdir(parents=True, exist_ok=True)
    onnx_dir = out_dir / 'onnx'
    onnx_dir.mkdir(parents=True, exist_ok=True)

    print(f'\nPreparing {model_id}', flush=True)
    run([
        sys.executable,
        '-m', 'optimum.exporters.onnx',
        '--model', model_id,
        '--task', 'text2text-generation',
        str(onnx_dir),
    ])
    copy_tokenizer(model_id, out_dir)
    print(f'Finished {model_id}', flush=True)

prepare('Helsinki-NLP/opus-mt-ar-fr', MODELS / 'ar-fr')
prepare('Helsinki-NLP/opus-mt-fr-ar', MODELS / 'fr-ar')
print('\nDone. The built website contains the ONNX model files, so translation can run without network access.', flush=True)
