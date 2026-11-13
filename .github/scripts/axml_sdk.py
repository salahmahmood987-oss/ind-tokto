#!/usr/bin/env python3
"""Parse a binary AndroidManifest.xml (AXML) and print the uses-sdk values.

Usage: python3 axml_sdk.py <AndroidManifest.xml>
Prints e.g.:
  minSdkVersion = 24
  targetSdkVersion = 36
Exits non-zero if the uses-sdk element or targetSdkVersion is missing.
Pure stdlib; no aapt2/bundletool needed.
"""
import struct
import sys

# Chunk types
RES_STRING_POOL_TYPE = 0x0001
RES_XML_START_NAMESPACE_TYPE = 0x0100
RES_XML_END_NAMESPACE_TYPE = 0x0101
RES_XML_START_ELEMENT_TYPE = 0x0102
RES_XML_END_ELEMENT_TYPE = 0x0103
RES_XML_CDATA_TYPE = 0x0104
RES_XML_RESOURCE_MAP_TYPE = 0x0180

UTF8_FLAG = 0x100
TYPE_INT_DEC = 0x10


def read_string_pool(data, off):
    # ResStringPool_header after the generic chunk header (8 bytes)
    _type, header_size, _size = struct.unpack_from("<HHI", data, off)
    string_count, style_count, flags, strings_start, styles_start = struct.unpack_from(
        "<IIIII", data, off + 8
    )
    is_utf8 = bool(flags & UTF8_FLAG)
    offsets_base = off + header_size
    strings_base = off + strings_start
    strings = []
    for i in range(string_count):
        str_off = struct.unpack_from("<I", data, offsets_base + i * 4)[0]
        p = strings_base + str_off
        if is_utf8:
            # UTF-8: u8 length (0x80|len for two-byte), then utf8 length, then bytes
            b0 = data[p]
            p += 1
            if b0 & 0x80:
                p += 1  # second length byte
            b1 = data[p]
            p += 1
            if b1 & 0x80:
                p += 1
            end = data.index(b"\x00", p)
            strings.append(data[p:end].decode("utf-8", "replace"))
        else:
            # UTF-16: u16 length (0x8000|len for two-word), then UTF-16LE chars
            w0 = struct.unpack_from("<H", data, p)[0]
            p += 2
            if w0 & 0x8000:
                p += 2
            length = w0 & 0x7FFF
            raw = data[p : p + length * 2]
            strings.append(raw.decode("utf-16-le", "replace"))
    return strings


def main():
    path = sys.argv[1]
    data = open(path, "rb").read()
    if len(data) < 8 or struct.unpack_from("<H", data, 0)[0] != 0x0003:
        print("not a binary AndroidManifest.xml", file=sys.stderr)
        sys.exit(1)

    strings = []
    off = 8  # skip the file header
    result = {}
    while off + 8 <= len(data):
        ctype, header_size, size = struct.unpack_from("<HHI", data, off)
        if size < 8 or off + size > len(data):
            break
        if ctype == RES_STRING_POOL_TYPE:
            strings = read_string_pool(data, off)
        elif ctype == RES_XML_START_ELEMENT_TYPE:
            # ResXMLTree_attrExt after the 16-byte element header
            line_number, comment, ns, name = struct.unpack_from("<IIII", data, off + 8)
            (attr_start, attr_size, attr_count, _id, _cls, _style) = struct.unpack_from(
                "<HHHHHH", data, off + 24
            )
            elem_name = strings[name] if 0 <= name < len(strings) else "?"
            if elem_name == "uses-sdk":
                attrs_base = off + 16 + attr_start
                for i in range(attr_count):
                    a_off = attrs_base + i * attr_size
                    a_ns, a_name, a_raw = struct.unpack_from("<III", data, a_off)
                    _vsize, _res0, dtype, dval = struct.unpack_from("<HBBI", data, a_off + 12)
                    aname = strings[a_name] if 0 <= a_name < len(strings) else "?"
                    if dtype == TYPE_INT_DEC:
                        result[aname] = dval
                    else:
                        result[aname] = f"(type 0x{dtype:02x}) {dval}"
        off += size

    if not result:
        print("uses-sdk element not found", file=sys.stderr)
        sys.exit(1)
    for k in ("minSdkVersion", "targetSdkVersion", "maxSdkVersion"):
        if k in result:
            print(f"{k} = {result[k]}")
    if "targetSdkVersion" not in result:
        print("targetSdkVersion missing", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
