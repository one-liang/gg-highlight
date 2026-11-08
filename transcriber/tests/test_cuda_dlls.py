import os

from gg_transcriber.cuda_dlls import nvidia_dll_dirs, setup_windows_cuda_dlls


def make_site(tmp_path, name='site-packages'):
    site = tmp_path / name
    for lib in ('cublas', 'cuda_nvrtc'):
        (site / 'nvidia' / lib / 'bin').mkdir(parents=True)
    (site / 'nvidia' / 'cublas' / 'include').mkdir()
    (site / 'nvidia' / 'no_bin').mkdir()
    return site


def test_finds_every_nvidia_bin_folder(tmp_path):
    site = make_site(tmp_path, 'site [1]')  # glob metacharacters in the path
    dirs = nvidia_dll_dirs([str(site), str(tmp_path / 'missing'), ''])
    assert dirs == [
        os.path.join(str(site), 'nvidia', 'cublas', 'bin'),
        os.path.join(str(site), 'nvidia', 'cuda_nvrtc', 'bin'),
    ]


def test_windows_prepends_path_and_registers_dll_dirs(tmp_path):
    site = make_site(tmp_path)
    added = []
    # No drive letters: on Linux os.pathsep is ':'.
    env = {'PATH': os.pathsep.join(['system32', 'tools'])}
    dirs = setup_windows_cuda_dlls(
        platform='win32',
        search_paths=[str(site)],
        environ=env,
        add_dll_directory=added.append,
    )
    assert len(dirs) == 2
    assert added == dirs
    parts = env['PATH'].split(os.pathsep)
    assert parts[:2] == dirs
    assert parts[2:] == ['system32', 'tools']

    # Running it again does not duplicate PATH entries.
    setup_windows_cuda_dlls(platform='win32', search_paths=[str(site)], environ=env, add_dll_directory=added.append)
    assert env['PATH'].split(os.pathsep) == parts


def test_windows_without_nvidia_wheels_changes_nothing(tmp_path):
    env = {'PATH': 'C:\\tools'}
    added = []
    assert setup_windows_cuda_dlls(platform='win32', search_paths=[str(tmp_path)], environ=env, add_dll_directory=added.append) == []
    assert env == {'PATH': 'C:\\tools'}
    assert added == []


def test_tolerates_add_dll_directory_errors(tmp_path):
    site = make_site(tmp_path)

    def fail(path):
        raise OSError('nope')

    env = {}
    dirs = setup_windows_cuda_dlls(platform='win32', search_paths=[str(site)], environ=env, add_dll_directory=fail)
    assert env['PATH'].split(os.pathsep) == dirs


def test_noop_off_windows(tmp_path):
    site = make_site(tmp_path)
    env = {'PATH': '/usr/bin'}
    assert setup_windows_cuda_dlls(platform='linux', search_paths=[str(site)], environ=env) == []
    assert env == {'PATH': '/usr/bin'}
