"""Line up sys.path so `import experiments.e005_...` works during pytest."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))