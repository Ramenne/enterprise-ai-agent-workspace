"""Shared current caller context; authority belongs to Hufu, never project legacy login."""
import contextvars
CURRENT_CALLER=contextvars.ContextVar("hufu_current_application_caller",default=None)
