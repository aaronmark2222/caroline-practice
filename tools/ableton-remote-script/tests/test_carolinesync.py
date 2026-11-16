"""CarolineSync checks with Live stubbed (nothing listens, no set is opened)."""
import importlib.util
import os
import sys
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.join(HERE, '..', 'CarolineSync')


def load():
    sys.modules.setdefault('Live', types.ModuleType('Live'))
    fw = sys.modules.setdefault('_Framework', types.ModuleType('_Framework'))
    cs = types.ModuleType('_Framework.ControlSurface')

    class ControlSurface(object):
        def __init__(self, *a):
            pass
    cs.ControlSurface = ControlSurface
    sys.modules['_Framework.ControlSurface'] = cs
    fw.ControlSurface = cs
    pkg = types.ModuleType('CarolineSync')
    pkg.__path__ = [PKG]
    sys.modules['CarolineSync'] = pkg
    out = {}
    for name in ('exporter', 'carolinesync'):
        spec = importlib.util.spec_from_file_location('CarolineSync.' + name, os.path.join(PKG, name + '.py'))
        mod = importlib.util.module_from_spec(spec)
        sys.modules['CarolineSync.' + name] = mod
        spec.loader.exec_module(mod)
        out[name] = mod
    return out


R2 = 'https://' + 'a' * 32 + '.r2.cloudflarestorage.com/tsp-practice/'


class Clip:
    def __init__(self, a, b, muted=False):
        self.start_time, self.end_time, self.muted = a, b, muted


class Track:
    def __init__(self, name, group=None, clips=(), fold=False, mute=False):
        self.name, self.group_track, self.arrangement_clips = name, group, list(clips)
        self.is_foldable, self.mute = fold, mute


class Cue:
    def __init__(self, t, n):
        self.time, self.name = t, n


class CarolineSyncTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = load()

    def test_links_only_caroline_folder(self):
        cs = self.m['carolinesync']
        good = {'lean-on-me': {'stems-vocals': {'put': R2 + 'caroline/lean-on-me/stems-vocals.m4a?X=1'}}}
        self.assertTrue(cs.links_ok(good))
        self.assertFalse(cs.links_ok({'lean-on-me': {'mixdown': {'put': R2 + 'songs/E5/mixdown.m4a?X=1'}}}))
        self.assertFalse(cs.links_ok({'lean-on-me': {'mixdown': {'put': R2 + 'caroline/ashayein/mixdown.m4a?X=1'}}}))
        self.assertFalse(cs.links_ok({'lean-on-me': {'mixdown': {'put': 'https://evil.example/caroline/lean-on-me/mixdown.m4a?X=1'}}}))

    def test_export_refused_unless_caroline_open(self):
        cs = self.m['carolinesync']
        bridge = object.__new__(cs.CarolineSync)
        bridge._export, bridge._busy = None, False
        bridge._run_on_main = lambda fn, *a, **k: {'ok': True, 'caroline_open': False, 'open_als_path': '/x/TSP.als'}
        out = bridge._export_request('/export', {'songs': [{'song_id': 'lean-on-me', 'start_beat': 0, 'end_beat': 124}]})
        self.assertEqual(out['error'], 'caroline_set_not_open')

    def _job(self, tracks, cues, locator='LEAN ON ME'):
        ex = self.m['exporter']
        song = types.SimpleNamespace(tracks=tracks, cue_points=cues)
        surf = types.SimpleNamespace(song=lambda: song, _descendants=lambda g: [t for t in tracks if t.group_track is g])
        els = [{'slug': 'stems-vocals', 'track': 'VOCALS', 'group': 'Stems', 'label': 'Vocals (stem)'},
               {'slug': 'parts-piano', 'track': 'Piano', 'group': 'Parts', 'label': 'Piano'},
               {'slug': 'parts-flute', 'track': 'Flute', 'group': 'Parts', 'label': 'Flute'},
               {'slug': 'cpc-click', 'track': 'CLICK', 'group': 'CPC', 'label': 'Click'},
               {'slug': 'mixdown', 'track': 'Mixdown', 'group': '', 'label': 'Mixdown'}]
        job = ex.CarolineExportJob(surf, [{'song_id': 'lean-on-me', 'song_name': 'Lean On Me', 'start': 0, 'end': 124, 'locator': locator}], '/tmp/x', {}, els)
        job._select_song(job.songs[0])
        return job

    def test_plan(self):
        stems, parts, cpc = Track('STEMS', fold=True), Track('PARTS', fold=True), Track('CPC', fold=True)
        tracks = [stems, Track('VOCALS', stems, [Clip(8, 120)], mute=True), parts, Track('Piano', parts, [Clip(8, 120)]),
                  Track('Flute', parts, [Clip(300, 400)]), cpc, Track('CLICK', cpc, [Clip(0, 124)]), Track('Piano')]
        job = self._job(tracks, [Cue(0, 'LEAN ON ME')])
        plan = job.plan()
        self.assertEqual(plan['elements'], ['stems-vocals', 'parts-piano', 'cpc-click', 'mixdown'])
        self.assertEqual(job.mix_notes['mixdown_tracks'], ['Piano', 'CLICK'])   # the muted stem stays out of the mixdown
        self.assertEqual(job._file_base('stems-vocals'), 'Lean On Me - Vocals (stem)')
        self.assertFalse(self._job(tracks, [Cue(4, 'LEAN ON ME')]).plan()['ok'])   # locator moved


if __name__ == '__main__':
    unittest.main()
