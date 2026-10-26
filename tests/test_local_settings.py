import unittest
from pydantic import ValidationError
from api.config import Settings

class LocalSettings(unittest.TestCase):
    def test_local_backend_allowed_only_outside_production(self):
        for url in ['http://127.0.0.1:54321','http://localhost:54321','http://[::1]:54321']:
            self.assertEqual(Settings(_env_file=None,supabase_url=url).supabase_url,url)
            with self.assertRaises(ValidationError):
                Settings(_env_file=None,environment='production',supabase_url=url,supabase_anon_key='test')
    def test_untrusted_remote_backend_is_rejected(self):
        for url in ['http://example.supabase.co','https://supabase.co.evil.example','https://user@project.supabase.co','https://project.supabase.co/unexpected','http://192.168.1.1:54321']:
            with self.assertRaises(ValidationError):Settings(_env_file=None,supabase_url=url)
    def test_hosted_backend_remains_supported(self):
        self.assertEqual(Settings(_env_file=None,supabase_url='https://project.supabase.co/').supabase_url,'https://project.supabase.co')
