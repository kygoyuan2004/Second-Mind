This tiny fixture is compiled from `uninstaller-fixture.nsi` using the pinned
electron-builder NSIS 3.0.4.1 `makensis` (zlib, forced CRC). The intermediate only
writes `native-uninstaller.exe` beside itself. Its uninstaller only writes a
diagnostic marker and exits; it removes no files and changes no registry keys.

Executing the intermediate on the Windows 11 acceptance host produced an
uninstaller with SHA256
`4b8e798b57d577b7ee658a1dcb993c9fed29f7ada41d9288881d2a2b0ca7a739`.
Native execution of that uninstaller and our correctly patched extraction both
returned 0. The upstream parser's extraction returned 2 because it omitted icon
resource patches and therefore failed the compiler-generated CRC.

The regression compares complete extracted bytes to the native SHA256, and
also checks corruption, missing patches and invalid resource offsets. These
fixtures are test inputs only and do not enter the installation package.
