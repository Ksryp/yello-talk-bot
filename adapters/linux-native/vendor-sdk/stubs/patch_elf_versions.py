#!/usr/bin/env python3
"""
Patch Android (bionic) ELF shared libraries to run on glibc Linux.

Android .so files use bionic's symbol versioning (LIBC version tag).
glibc uses GLIBC_2.x version tags, so the symbols won't resolve.

This script:
1. Zeros .gnu.version entries (sets all to VER_NDX_GLOBAL=1)
   so the dynamic linker accepts any version of each symbol.
2. Sets DT_VERNEEDNUM to 0 in the .dynamic section so the linker
   skips version requirement checking entirely.

After patching, create symlinks for DT_NEEDED resolution:
  libc.so -> /lib/x86_64-linux-gnu/libc.so.6
  libm.so -> /lib/x86_64-linux-gnu/libm.so.6
  libdl.so -> /lib/x86_64-linux-gnu/libdl.so.2

Usage: python3 patch_elf_versions.py libgmesdk.so [libgmefdkaac.so ...]
"""

import struct
import sys
import os

# ELF constants
EI_CLASS = 4
ELFCLASS64 = 2
SHT_GNU_versym = 0x6fffffff   # .gnu.version
SHT_GNU_verneed = 0x6ffffffe  # .gnu.version_r
SHT_DYNAMIC = 6               # .dynamic

# Dynamic section tag values
DT_NULL = 0
DT_VERNEED = 0x6ffffffe
DT_VERNEEDNUM = 0x6fffffff
DT_VERSYM = 0x6ffffff0


def patch_elf(filename):
    with open(filename, 'r+b') as f:
        # Read ELF header
        f.seek(0)
        e_ident = f.read(16)
        if e_ident[:4] != b'\x7fELF':
            print(f"  SKIP {filename}: not an ELF file")
            return False

        if e_ident[EI_CLASS] != ELFCLASS64:
            print(f"  SKIP {filename}: not 64-bit ELF")
            return False

        # Read rest of ELF header (64-bit)
        f.seek(16)
        header = f.read(48)
        (e_type, e_machine, e_version, e_entry, e_phoff, e_shoff,
         e_flags, e_ehsize, e_phentsize, e_phnum, e_shentsize,
         e_shnum, e_shstrndx) = struct.unpack('<HHIQQQIHHHHHH', header)

        # Read section header string table
        f.seek(e_shoff + e_shstrndx * e_shentsize)
        shstr_hdr = f.read(e_shentsize)
        (sh_name, sh_type, sh_flags, sh_addr, sh_offset, sh_size,
         sh_link, sh_info, sh_addralign, sh_entsize) = struct.unpack('<IIQQQQIIQQ', shstr_hdr)
        f.seek(sh_offset)
        shstrtab = f.read(sh_size)

        patched = False

        # Iterate section headers
        for i in range(e_shnum):
            f.seek(e_shoff + i * e_shentsize)
            sec_hdr = f.read(e_shentsize)
            (sh_name, sh_type, sh_flags, sh_addr, sh_offset, sh_size,
             sh_link, sh_info, sh_addralign, sh_entsize) = struct.unpack('<IIQQQQIIQQ', sec_hdr)

            name_end = shstrtab.find(b'\x00', sh_name)
            sec_name = shstrtab[sh_name:name_end].decode('ascii', errors='replace')

            if sh_type == SHT_GNU_versym:
                # .gnu.version: array of uint16_t version indices
                # Set all entries > 1 to 1 (VER_NDX_GLOBAL = unversioned)
                f.seek(sh_offset)
                data = bytearray(f.read(sh_size))
                num_entries = sh_size // 2
                changes = 0
                for j in range(num_entries):
                    val = struct.unpack_from('<H', data, j * 2)[0]
                    if val > 1:
                        struct.pack_into('<H', data, j * 2, 1)
                        changes += 1
                f.seek(sh_offset)
                f.write(data)
                print(f"  Patched {sec_name}: {changes}/{num_entries} version entries -> unversioned")
                patched = True

            elif sh_type == SHT_DYNAMIC:
                # .dynamic: array of Elf64_Dyn {d_tag: int64, d_val: uint64}
                # glibc's ld.so checks if a DT_VERNEED entry EXISTS in the
                # dynamic section (l_info[DT_VERNEED] != NULL). Simply setting
                # the value to 0 doesn't help — we must remove the entry.
                #
                # We change the DT_VERNEED and DT_VERNEEDNUM tags to an
                # unused OS-specific tag (DT_LOOS = 0x6000000d) that glibc
                # stores but never acts on. This effectively disables version
                # requirement checking.
                DT_IGNORED = 0x6000000d  # OS-specific, unused by glibc
                f.seek(sh_offset)
                data = bytearray(f.read(sh_size))
                entry_size = 16  # sizeof(Elf64_Dyn) = 8 + 8
                num_entries = sh_size // entry_size
                dynamic_patched = False
                for j in range(num_entries):
                    off = j * entry_size
                    d_tag = struct.unpack_from('<q', data, off)[0]
                    if d_tag == DT_NULL:
                        break
                    if d_tag == DT_VERNEED:
                        # Replace tag so ld.so won't find DT_VERNEED
                        struct.pack_into('<q', data, off, DT_IGNORED)
                        print(f"  Removed DT_VERNEED (replaced tag with 0x{DT_IGNORED:x})")
                        dynamic_patched = True
                    elif d_tag == DT_VERNEEDNUM:
                        struct.pack_into('<q', data, off, DT_IGNORED + 1)
                        print(f"  Removed DT_VERNEEDNUM (replaced tag with 0x{DT_IGNORED+1:x})")
                        dynamic_patched = True
                    elif d_tag == DT_VERSYM:
                        # Without DT_VERNEED/DT_VERDEF, ld.so never allocates
                        # l_versions, but a remaining DT_VERSYM makes relocation
                        # index into it (NULL deref → SIGSEGV inside dlopen).
                        struct.pack_into('<q', data, off, DT_IGNORED - 1)
                        print(f"  Removed DT_VERSYM (replaced tag with 0x{DT_IGNORED-1:x})")
                        dynamic_patched = True
                if dynamic_patched:
                    f.seek(sh_offset)
                    f.write(data)
                    patched = True

        return patched


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <file.so> [file2.so ...]")
        sys.exit(1)

    for filename in sys.argv[1:]:
        print(f"Patching: {filename}")
        if not os.path.exists(filename):
            print(f"  ERROR: file not found")
            continue
        if patch_elf(filename):
            print(f"  OK")
        else:
            print(f"  No changes needed")


if __name__ == '__main__':
    main()
