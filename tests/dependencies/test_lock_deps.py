"""Exercise the real resolver against local wheels, without registry access."""

import os
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


class LockfileCheckTests(unittest.TestCase):
    def test_available_updates_are_optional_but_changed_requirements_are_checked(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            scripts = root / "scripts"
            scripts.mkdir()
            shutil.copyfile(REPO / "scripts/lock-deps.sh", scripts / "lock-deps.sh")
            source = root / "base/rag/indexer"
            source.mkdir(parents=True)
            wheels = root / "wheels"
            wheels.mkdir()

            def wheel(name, version, dependencies=()):
                info = f"{name}-{version}.dist-info"
                metadata = f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n"
                metadata += "".join(f"Requires-Dist: {dependency}\n" for dependency in dependencies)
                with zipfile.ZipFile(wheels / f"{name}-{version}-py3-none-any.whl", "w") as archive:
                    archive.writestr(f"{info}/METADATA", metadata)
                    archive.writestr(f"{info}/WHEEL", "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
                    archive.writestr(f"{info}/RECORD", "")

            def requirements(version):
                (source / "requirements.txt").write_text(f"--no-index\n--find-links {wheels}\nlockdemo>={version}\n")

            def run(*arguments):
                return subprocess.run(
                    ["bash", str(scripts / "lock-deps.sh"), *arguments],
                    cwd=root,
                    env={**os.environ, "UV_CACHE_DIR": str(root / "cache"), "UV_OFFLINE": "1"},
                    text=True,
                    capture_output=True,
                    timeout=30,
                    check=False,
                )

            wheel("lockdep", "1.0")
            wheel("lockdemo", "1.0", ["lockdep>=1"])
            requirements("1")
            generated = run()
            self.assertEqual(generated.returncode, 0, generated.stdout + generated.stderr)
            lock = source / "requirements.lock"
            original = lock.read_bytes()
            self.assertIn(b"lockdemo==1.0", original)
            self.assertIn(b"lockdep==1.0", original)

            wheel("lockdemo", "2.0")
            unchanged = run("--check")
            self.assertEqual(unchanged.returncode, 0, unchanged.stdout + unchanged.stderr)
            self.assertEqual(lock.read_bytes(), original)

            requirements("2")
            stale = run("--check")
            self.assertNotEqual(stale.returncode, 0)
            self.assertIn("STALE", stale.stdout + stale.stderr)
            self.assertEqual(lock.read_bytes(), original)

            refreshed = run()
            self.assertEqual(refreshed.returncode, 0, refreshed.stdout + refreshed.stderr)
            self.assertIn(b"lockdemo==2.0", lock.read_bytes())
            self.assertNotIn(b"lockdep==", lock.read_bytes())
            self.assertEqual(run("--check").returncode, 0)
