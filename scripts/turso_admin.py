"""Initialize OctoMinds or create its first owner without printing credentials."""
import argparse
from getpass import getpass

from api.config import get_settings
from api.turso.accounts import hasher, password_valid
from api.turso.db import initialize, now, transaction


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    commands=parser.add_subparsers(dest='command',required=True)
    commands.add_parser('init')
    owner=commands.add_parser('owner')
    owner.add_argument('--email',required=True)
    owner.add_argument('--name',required=True)
    args=parser.parse_args()
    settings=get_settings()
    initialize(settings)
    if args.command=='init':
        print('OctoMinds database schema is ready.')
        return
    email=args.email.strip().lower()
    if '@' not in email or not args.name.strip():
        parser.error('Enter an email address and name.')
    password=getpass('Owner password: ')
    if not password_valid(email,password) or getpass('Confirm password: ')!=password:
        parser.error('Passwords must match and satisfy the password policy.')
    with transaction(settings,write=True) as db:
        if db.scalar("select 1 from user_memberships where role='super_admin'"):
            parser.error('An owner already exists. Use account recovery or school administration.')
        account=db.insert('accounts',{'email':email,'password_hash':hasher.hash(password),'email_confirmed_at':now()})
        db.insert('profiles',{'id':account['id'],'full_name':args.name.strip()})
        db.insert('user_memberships',{'user_id':account['id'],'role':'super_admin','branch_id':None})
    print('First owner created.')


if __name__=='__main__':
    main()
