"""``python -m xd_engine --root <루트>`` — XD main 이 띄우는 입구."""

import sys

from xd_engine.daemon import main

sys.exit(main())
