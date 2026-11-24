"""Server-only adapter for existing school and family API contracts."""
from contextlib import contextmanager

from ..auth import resolve_account
from . import families, photos, school
from .access import Access
from .db import transaction

COMMANDS = {
    'school_workspace': school.workspace,
    'school_save_record': school.save_record,
    'school_access_directory': school.directory,
    'school_access_command': school.access_command,
    'school_accept_invitation': school.accept_invitation,
    'parents_workspace': families.workspace,
    'parents_child_profile': families.child_profile,
    'parents_feed': families.feed,
    'parents_calendar': families.calendar,
    'parents_thread': families.thread,
    'parents_send_message': families.send_message,
    'parents_save_student': families.save_student,
    'parents_link_guardian': families.link_guardian,
    'parents_publish': families.publish,
    'parents_unpublish': families.unpublish,
    'parents_gallery': photos.gallery,
    'parents_staff_albums': lambda access, p_page, p_class=None: photos.gallery(access, p_page=p_page, p_class=p_class),
    'parents_album_detail': photos.detail,
    'parents_create_album': photos.create_album,
    'parents_album_command': photos.command,
}
READS = {'school_workspace', 'school_access_directory', 'parents_workspace', 'parents_child_profile',
         'parents_feed', 'parents_calendar', 'parents_thread',
         'parents_gallery', 'parents_staff_albums', 'parents_album_detail'}


class SchoolRepository:
    def __init__(self, settings, token):
        self.settings, self.token = settings, token

    @contextmanager
    def access(self, write=False):
        with transaction(self.settings, write=write) as db:
            account = resolve_account(db, self.token)
            yield Access(db, account['id'])

    def request(self, method, path, *, data=None):
        command = path.removeprefix('/rpc/')
        if method != 'POST' or not path.startswith('/rpc/') or command not in COMMANDS:
            raise ValueError('Unsupported application operation')
        with self.access(write=command not in READS) as access:
            return COMMANDS[command](access, **(data or {}))
