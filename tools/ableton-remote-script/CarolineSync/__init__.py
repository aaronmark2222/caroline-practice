"""CarolineSync control surface for Ableton Live 12 (Caroline Practice).

Lets the Caroline Practice app (Ableton Sync page, admin only) export the
songs of Caroline.als through Live's own Export dialog and upload them to R2.
Completely separate from the band's TSPWork; both can be selected at once.
Install: copy this CarolineSync folder to
  ~/Music/Ableton/User Library/Remote Scripts/
then pick "CarolineSync" in an empty Control Surface slot in Live's
Settings > Link, Tempo & MIDI (Input/Output: None).
"""
import importlib

from . import carolinesync


def create_instance(c_instance):
    importlib.reload(carolinesync)
    return carolinesync.CarolineSync(c_instance)
