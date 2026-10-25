"""Build a relocatable macOS ARM64 audio runtime inside Electron Resources."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import urllib.request

PYTHON_URL = 'https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.11.16%2B20260901-aarch64-apple-darwin-pgo%2Blto-full.tar.zst'
PYTHON_SHA256 = '19b8d2af1719e3fe8cd4edfa2e5030dab776233c05044f4348dbe3c0af7d1b2f'


# Build-time and GUI parts the worker never loads; the smoke test below runs after pruning.
PRUNE = [
    'lib/libpython3.11.a', 'lib/python3.11/config-3.11-darwin', 'lib/pkgconfig', 'include', 'share',
    'lib/python3.11/test', 'lib/python3.11/ensurepip', 'lib/python3.11/idlelib', 'lib/python3.11/tkinter',
    'lib/python3.11/turtledemo', 'lib/python3.11/lib-dynload/_tkinter*', 'lib/libtcl*', 'lib/libtk*',
    'lib/tcl9*', 'lib/tk9*', 'lib/itcl*', 'lib/thread*', 'bin/idle3*', 'bin/pip*', 'bin/2to3*', 'bin/python3*-config',
    'lib/python3.11/site-packages/pip', 'lib/python3.11/site-packages/pip-*',
    'lib/python3.11/site-packages/setuptools', 'lib/python3.11/site-packages/setuptools-*',
    'lib/python3.11/site-packages/_distutils_hack', 'lib/python3.11/site-packages/pkg_resources',
    'lib/python3.11/site-packages/distutils-precedence.pth',
    'lib/python3.11/site-packages/onnxruntime/transformers', 'lib/python3.11/site-packages/onnxruntime/quantization',
    'lib/python3.11/site-packages/onnxruntime/tools', 'lib/python3.11/site-packages/numpy/f2py',
    'lib/python3.11/site-packages/numpy/distutils', 'lib/python3.11/site-packages/numpy/**/tests',
]


def prune(root):
    for pattern in PRUNE:
        for path in sorted(root.glob(pattern), reverse=True):
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
            elif path.exists() or path.is_symlink():
                path.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        parser.error('Build this runtime on macOS ARM64; cross-compilation is not supported.')
    source = args.source.resolve()
    output = args.output.resolve()
    if not (source / 'scripts/build_rnnoise.py').is_file():
        parser.error('Audio source missing. Set DEX_AUDIO_SOURCE to the extracted audio library source.')
    if output.exists():
        parser.error(f'Refusing to overwrite existing output: {output}')
    env = {k: v for k, v in os.environ.items() if k not in ('PYTHONPATH', 'PYTHONHOME', 'XGEN_RNNOISE_LIBRARY')}
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    env['PYTHONNOUSERSITE'] = '1'
    with tempfile.TemporaryDirectory(prefix='dex-audio-pack-') as temp:
        work = Path(temp)
        archive = work / 'python.tar.zst'
        urllib.request.urlretrieve(PYTHON_URL, archive)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != PYTHON_SHA256:
            raise RuntimeError('Python archive checksum mismatch')
        subprocess.run(['tar', '-xf', str(archive), '-C', str(work)], check=True)
        install = work / 'python/install'
        output.mkdir(parents=True)
        shutil.copytree(install, output / 'python', symlinks=True)
        # The full distribution carries notices for Python's bundled native libraries.
        shutil.copytree(work / 'python/licenses', output / 'licenses/python')
        shutil.copy2(work / 'python/PYTHON.json', output / 'licenses/python/PYTHON.json')
        python = output / 'python/bin/python3.11'
        def run(*cmd):
            subprocess.run([str(c) for c in cmd], cwd=work, env=env, check=True)
        run(python, '-I', '-m', 'pip', '--isolated', '--no-cache-dir', 'install',
            '-c', Path(__file__).with_name('audio-runtime-constraints.txt'), source)
        run(python, source / 'scripts/build_rnnoise.py', '--output', work / 'rnnoise')
        (output / 'lib').mkdir()
        shutil.copy2(work / 'rnnoise/librnnoise.dylib', output / 'lib/librnnoise.dylib')
        shutil.copytree(source / 'src/xgen_audio/licenses', output / 'licenses/audio')
        shutil.copytree(source / 'src/xgen_audio/models', output / 'licenses/models', ignore=shutil.ignore_patterns('*.onnx'))
        run(python, '-I', '-m', 'pip', 'check')
        versions = subprocess.check_output([str(python), '-I', '-m', 'pip', 'list', '--format=json'], env=env, text=True)
        prune(output / 'python')
        env['XGEN_RNNOISE_LIBRARY'] = str(output / 'lib/librnnoise.dylib')
        run(python, '-I', '-c', '''
from xgen_audio import AudioPreprocessor
raw=bytes(32000)
for noise in ('none','rnnoise'):
 for vad in (False,True):
  with AudioPreprocessor(denoise=noise,vad=vad) as p:
   chunks=[p.push(raw[i:i+2048]) for i in range(0,len(raw),2048)]+[p.finish()]
   assert sum(len(c.pcm) for c in chunks)==len(raw)
   assert not any(c.events for c in chunks)
print('Bundled audio runtime: four combinations passed')
''')
        (output / 'manifest.json').write_text(json.dumps({
            'platform': 'darwin', 'arch': 'arm64', 'pythonArchive': PYTHON_URL,
            'pythonSha256': PYTHON_SHA256, 'packages': json.loads(versions),
        }, indent=2) + '\n')
        (output / 'THIRD_PARTY_NOTICES.txt').write_text('''DEX audio runtime

RNNoise copyright, BSD license conditions and disclaimer: licenses/audio/RNNoise-COPYING.txt
Silero model notices: licenses/models/
CPython and bundled native-library notices: licenses/python/ and python/lib/python3.11/LICENSE.txt
Python package notices (including NumPy, ONNX Runtime, soxr): python/lib/python3.11/site-packages/*.dist-info/
Additional soxr LGPL and bundled-library notices: licenses/audio/

Runtime binaries are shipped separately from app.asar. They may be replaced with
compatible builds. DEX_AUDIO_ROOT / DEX_AUDIO_PYTHON / XGEN_RNNOISE_LIBRARY can override them.
Dependency versions and Python source are recorded in manifest.json.
''')
        # Disallow links to a developer's machine; the app must survive relocation.
        for path in output.rglob('*'):
            if path.is_symlink() and not path.resolve().is_relative_to(output):
                raise RuntimeError(f'External runtime symlink: {path}')
        print(f'Audio runtime packaged: {output}', flush=True)


if __name__ == '__main__':
    main()
