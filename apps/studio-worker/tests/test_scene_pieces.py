import json
import shutil

from conftest import FIXTURES
from test_jobs import api, client, fake_command, fake_render, prompt_job  # noqa: F401 (api is a fixture)
from studio_worker import jobs
from studio_worker.pieces import collect

SCENE = FIXTURES / 'scene'


def lay_out(design, *folders, meta=None, files=None):
    """Copies scene fixture folders into design/out/, then overrides piece.json fields and writes extra files."""
    for f in folders:
        shutil.copytree(SCENE / f, design / 'out' / f)
    for folder, fields in (meta or {}).items():
        p = design / 'out' / folder / 'piece.json'
        p.write_text(json.dumps({**json.loads(p.read_text()), **fields}))
    for rel, data in (files or {}).items():
        path = design / 'out' / rel
        if data is None:
            path.unlink()
        else:
            path.write_text(json.dumps(data) if not isinstance(data, str) else data)
    return design


def scene(design, *folders, **kw):
    lay_out(design, *folders, **kw)
    return collect(design, 'scene', {})


def test_collects_a_building_and_a_chair_with_their_extras(tmp_path, skills):
    pieces, proposal, error = scene(tmp_path, 'building', 'furniture_chair')
    assert error is None and proposal is None
    assert [p.category for p in pieces] == ['building', 'furniture_chair']
    building, chair = pieces
    assert sorted(e.name for e in building.extras) == ['layout.json', 'route.json']
    assert [e.name for e in chair.extras] == ['chair.sittables.json']
    assert building.checker['pass'] is True and chair.checker['pass'] is True, building.checker['report']


def test_a_folder_virvi_cannot_store_is_a_problem(tmp_path, skills):
    lay_out(tmp_path, 'furniture_chair')
    shutil.move(tmp_path / 'out/furniture_chair', tmp_path / 'out/furniture_Round-Table')
    shutil.copytree(SCENE / 'furniture_wide_couch', tmp_path / 'out/chair')
    pieces, _, error = collect(tmp_path, 'scene', {})
    assert pieces == []
    assert 'furniture_<name>' in error and 'out/furniture_Round-Table' in error and 'out/chair' in error


def test_more_than_one_building_or_twelve_furniture_is_a_problem(tmp_path, skills):
    lay_out(tmp_path, 'furniture_chair')
    for i in 'abcdefghijkl':
        shutil.copytree(SCENE / 'furniture_chair', tmp_path / f'out/furniture_chair_{i}')
    _, _, error = collect(tmp_path, 'scene', {})
    assert error and '12' in error


def test_a_scene_piece_has_exactly_one_glb(tmp_path, skills):
    lay_out(tmp_path, 'furniture_chair')
    shutil.copy(SCENE / 'furniture_wide_couch/couch.glb', tmp_path / 'out/furniture_chair/couch.glb')
    pieces, _, error = collect(tmp_path, 'scene', {})
    assert pieces == [] and 'out/furniture_chair' in error and 'one GLB' in error


def test_a_building_without_a_route_fails_its_check_with_what_to_write(tmp_path, skills):
    pieces, _, error = scene(tmp_path, 'building', files={'building/route.json': None})
    assert error is None
    assert pieces[0].checker['pass'] is False
    assert 'route.json missing' in pieces[0].checker['report']


def test_a_route_that_never_reaches_its_floor_fails(tmp_path, skills):
    pieces, _, _ = scene(tmp_path, 'building', files={'building/route.json': {'waypoints': [[0, 8], [0, 0, 3.0]]}})
    assert pieces[0].checker['pass'] is False
    assert 'expects floor y 3' in pieces[0].checker['report']


def test_furniture_blocking_the_door_only_warns(tmp_path, skills):
    layout = {'furniture': [{'category': 'furniture_wide_couch', 'x': 0, 'z': 4.0, 'yaw': 90}]}
    pieces, _, _ = scene(tmp_path, 'building', 'furniture_wide_couch', files={'building/layout.json': layout})
    building = pieces[0]
    assert building.checker['pass'] is True
    assert building.checker['warnings'] >= 1
    assert 'furnished walk' in building.checker['report']


def test_a_layout_naming_a_missing_piece_warns_and_skips_it(tmp_path, skills):
    pieces, _, _ = scene(tmp_path, 'building')  # the layout names furniture_chair, which isn't there
    building = pieces[0]
    assert building.checker['pass'] is True and building.checker['warnings'] >= 1
    assert 'furniture_chair' in building.checker['report']


def test_triangles_over_the_recommendation_are_reported_not_failed(tmp_path, skills):
    import glbfactory as gf
    lay_out(tmp_path, 'building')
    bricks = [gf.box(f'Brick{i}', (-4 + (i % 20) * 0.4, 0, -4 + (i // 20) * 0.4), (-3.9 + (i % 20) * 0.4, 0.1, -3.9 + (i // 20) * 0.4))
              for i in range(300)]
    walls = [n for n in __import__('make_scene_fixtures').room()]
    gf.write(tmp_path / 'out/building/kiosk.glb', walls + bricks)
    pieces, _, _ = collect(tmp_path, 'scene', {})
    checker = pieces[0].checker
    assert checker['pass'] is True
    assert checker['triangles'] == {'count': 3672, 'limit': 3000}


def test_extras_upload_with_the_piece(api, tmp_path, skills):
    result = jobs.run_job(prompt_job(kind='scene', selectedSlots=None, prompt='a little kiosk'), client(api), tmp_path,
                          render_fn=fake_render([]), command=fake_command('claude_builds_kiosk.jsonl'), as_user=None)
    assert result['outcome'] == 'ok', result
    assert {'job-1/pieces/building/route.json', 'job-1/pieces/building/layout.json',
            'job-1/pieces/furniture_chair/chair.sittables.json'} <= set(api.files)
    assert all('triangles' in p['checker'] for p in result['pieces'])


def test_a_changed_route_alone_marks_the_building_changed(tmp_path, skills):
    from studio_worker.pieces import new_hashes
    pieces, _, _ = scene(tmp_path, 'building')
    before = new_hashes(pieces)
    (tmp_path / 'out/building/route.json').write_text(json.dumps({'waypoints': [[0, 8], [0, 1]]}))
    again, _, _ = collect(tmp_path, 'scene', before)
    assert again[0].changed is True
    same, _, _ = collect(tmp_path, 'scene', new_hashes(again))
    assert same[0].changed is False
