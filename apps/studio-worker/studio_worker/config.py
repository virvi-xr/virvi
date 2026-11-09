"""Fixed paths and names in the worker image."""
import subprocess
from pathlib import Path

SKILLS = Path('/opt/skills')
ASSETS = Path('/opt/assets')  # the official base avatar .blend files
ANIMATIONS = Path('/opt/dcl-animations')  # Decentraland's avatar animations, for the clipping check
DESIGN = Path('/work/design')  # the design's workspace, owned by AGENT_USER
AGENT_USER = 'agent'
PREVIEW_URL = 'https://wearable-preview.decentraland.org/'
# Outfit name -> body shape -> wearable-preview `profile` value (a deterministic default outfit). The preview dresses the
# requested body in the profile's own hair, face and clothes, so each body wears a profile made for it: default1 is a
# BaseFemale avatar and looked like a woman on the male body (LIV-143). Long sleeves and trousers; short sleeves and
# shorts; then a skirt (a dress for the female body, a kilt for the male one).
OUTFITS = {'default': {'male': 'default81', 'female': 'default1'},
           'outfit-2': {'male': 'default96', 'female': 'default13'},
           'outfit-3': {'male': 'default83', 'female': 'default4'}}
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
