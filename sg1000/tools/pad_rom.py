#!/usr/bin/env python3
import sys
data = open(sys.argv[1], 'rb').read()
size = len(data)
if size > 32768:
    sys.exit("ROM too big: %d > 32768" % size)
data = data + b'\xff' * (32768 - size)
open(sys.argv[2], 'wb').write(data)
print("rom size %d -> padded 32768" % size)
