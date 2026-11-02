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


def scene_render_job(spec):
    return {'jobId': 'job-r', 'type': 'render', 'kind': 'scene', 'agent': None, 'model': None, 'prompt': None,
            'selectedSlots': None, 'limits': None, 'render': spec}


def scene_prompt(api, tmp_path, renders):
    return jobs.run_job(prompt_job(kind='scene', selectedSlots=None, prompt='a little kiosk'), client(api), tmp_path,
                        render_fn=fake_render(renders), command=fake_command('claude_builds_kiosk.jsonl'), as_user=None)


def test_scene_building_prompt_renders_the_inspect_ring(api, tmp_path, skills):
    renders = []
    result = scene_prompt(api, tmp_path, renders)
    assert result['outcome'] == 'ok', result
    building = next(p for p in result['pieces'] if p['category'] == 'building')
    assert building['renders'] == {'orbit-scene': 24}
    assert len([f for f in api.files if f.startswith('job-1/renders/building/orbit-scene/')]) == 24


def test_scene_furniture_prompt_renders_scale_and_ring(api, tmp_path, skills):
    renders = []
    result = scene_prompt(api, tmp_path, renders)
    chair = next(p for p in result['pieces'] if p['category'] == 'furniture_chair')
    assert chair['renders'] == {'scale': 36, 'orbit-scene': 24}
    assert [v['mode'] for pieces, v in renders if pieces[0]['category'] == 'furniture_chair'] == ['scale', 'scene-orbit']


def test_scene_orbit_render_job_full_sphere(api, tmp_path, skills):
    lay_out(tmp_path, 'building')
    result = jobs.run_job(scene_render_job({'categories': ['building'], 'mode': 'orbit', 'ring': False}), client(api),
                          tmp_path, render_fn=fake_render([]), as_user=None)
    assert result['outcome'] == 'ok', result
    assert result['pieces'] == [{'category': 'building', 'renders': {'orbit-scene': 122}}]
    assert 'job-r/renders/building/orbit-scene/121.webp' in api.files


def test_tour_set_job_places_the_furniture(api, tmp_path, skills):
    lay_out(tmp_path, 'building', 'furniture_chair')
    renders = []
    result = jobs.run_job(scene_render_job({'set': True, 'tour': True}), client(api), tmp_path,
                          render_fn=fake_render(renders), as_user=None)
    assert result['outcome'] == 'ok', result
    pieces, view = renders[0]
    assert {p['category']: p['at'] for p in pieces} == {'building': None, 'furniture_chair': {'x': 3, 'z': -3, 'yaw': 0}}
    assert view['mode'] == 'tour' and len(view['path']) > 100
    assert result['set'] == {'viewKey': 'tour', 'frames': 96, 'fps': 24.0}
    assert 'job-r/renders/set/tour/095.webp' in api.files


def test_tour_skips_a_missing_layout_piece_and_says_so(api, tmp_path, skills):
    lay_out(tmp_path, 'building')
    result = jobs.run_job(scene_render_job({'set': True, 'tour': True}), client(api), tmp_path,
                          render_fn=fake_render([]), as_user=None)
    assert result['outcome'] == 'ok', result
    assert any('furniture_chair' in w for w in result['warnings'])


def test_tour_without_a_building_is_an_error(api, tmp_path, skills):
    lay_out(tmp_path, 'furniture_chair')
    result = jobs.run_job(scene_render_job({'set': True, 'tour': True}), client(api), tmp_path,
                          render_fn=fake_render([]), as_user=None)
    assert result['outcome'] == 'error' and 'building' in result['error']


def test_furniture_bigger_than_half_a_parcel_fails_as_a_building_in_disguise(tmp_path, skills):
    # a 20 m "couch" would be priced as furniture; anything over 8 m (a 0.5x0.5 parcel) is a building
    import glbfactory as gf
    lay_out(tmp_path, 'furniture_wide_couch')
    gf.write(tmp_path / 'out/furniture_wide_couch/couch.glb', [gf.box('House', (-10, 0, -4), (10, 6, 4)),
                                                              gf.box('House_collider', (-10, 0, -4), (10, 6, 4), material=None)])
    pieces, _, _ = collect(tmp_path, 'scene', {})
    assert pieces[0].checker['pass'] is False
    assert 'out/building/' in pieces[0].checker['report']


def test_a_file_name_virvi_cannot_store_is_a_problem(tmp_path, skills):
    lay_out(tmp_path, 'furniture_chair')
    (tmp_path / 'out/furniture_chair/chair.glb').rename(tmp_path / 'out/furniture_chair/Round Chair.glb')
    pieces, _, error = collect(tmp_path, 'scene', {})
    assert pieces == [] and 'Round Chair.glb' in error


def test_a_malformed_layout_entry_is_skipped_with_a_warning(api, tmp_path, skills):
    layout = {'furniture': [{'category': 'furniture_chair', 'x': 'left', 'z': -3, 'yaw': 0}]}
    pieces, _, _ = scene(tmp_path, 'building', 'furniture_chair', files={'building/layout.json': layout})
    assert pieces[0].checker['pass'] is True and 'not a number' in pieces[0].checker['report']
    result = jobs.run_job(scene_render_job({'set': True, 'tour': True}), client(api), tmp_path,
                          render_fn=fake_render([]), as_user=None)
    assert result['outcome'] == 'ok', result
    assert any('not a number' in w for w in result['warnings'])
