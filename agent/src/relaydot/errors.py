"""Domain exceptions exposed by the agent core."""


class RelaydotError(Exception):
    """Base class for expected Relaydot failures."""


class PolicyError(RelaydotError):
    """A policy is invalid or unsafe."""


class UnsafePathError(RelaydotError):
    """A path could escape its declared synchronization root."""


class BundleError(RelaydotError):
    """A revision bundle is malformed or unsafe."""


class ApplyError(RelaydotError):
    """A staged revision could not be applied atomically."""
