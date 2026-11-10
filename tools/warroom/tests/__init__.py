# No test may reach the operator's live tmux sessions or signal a real process through the restart Controller (#5162):
# the suite runs on the machine that hosts the production `warroom` / `warroom-supervisor` sessions. A test that needs
# tmux patches `restart_controller._tmux` itself; everything else sees "no such session".
from unittest import mock as _mock

from warroom import restart_controller as _rc

_rc._tmux = lambda command, timeout=5: _mock.Mock(returncode=1, stdout="", stderr="")
_rc._signal_supervisor = lambda pid, group, sig: None
_rc._sweep_group = lambda pgid: None
