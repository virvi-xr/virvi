"""Fixed paths and names in the worker image."""
import subprocess
from pathlib import Path

SKILLS = Path('/opt/skills')
ASSETS = Path('/opt/assets')  # the official base avatar .blend files
ANIMATIONS = Path('/opt/dcl-animations')  # Decentraland's avatar animations, for the clipping check
DESIGN = Path('/work/design')  # the design's workspace, owned by AGENT_USER
AGENT_USER = 'agent'
PREVIEW_URL = 'https://wearable-preview.decentraland.org/'
# Outfit name -> wearable-preview `profile` value (a deterministic default outfit)
OUTFITS = {'default': 'default1', 'outfit-2': 'default2', 'outfit-3': 'default3'}
BASE_EMOTES = ('idle', 'wave', 'dance', 'clap', 'walk', 'run', 'jump')


def skills_sha(repo: Path = SKILLS) -> str | None:
    """The skills commit, or None when the repo is missing. The repo is root-owned and the caller may be `agent`,
    so git's safe.directory check is waived for this one read."""
    try:
        p = subprocess.run(['git', '-c', 'safe.directory=*', '-C', str(repo), 'rev-parse', 'HEAD'],
                           capture_output=True, text=True)
    except OSError:
        return None
    return p.stdout.strip() if p.returncode == 0 and p.stdout.strip() else None
