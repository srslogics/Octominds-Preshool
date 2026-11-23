import unittest
from fastapi.testclient import TestClient
from api.main import app

class CleanPageURLs(unittest.TestCase):
    def test_canonical_pages_and_head(self):
        with TestClient(app) as client:
            for path, marker in [('/', 'loginForm'), ('/school', 'signInForm'), ('/parents', 'childSelect')]:
                response = client.get(path)
                self.assertEqual(response.status_code, 200)
                self.assertIn(marker, response.text)
                self.assertEqual(client.head(path).status_code, 200)
    def test_legacy_links_preserve_query(self):
        with TestClient(app) as client:
            for old, new in [('/parents.html','/parents'),('/parents/','/parents'),('/school.html','/school'),('/school/','/school'),('/index.html','/'),('/index','/')]:
                response=client.get(old+'?source=email', follow_redirects=False)
                self.assertEqual(response.status_code,308)
                self.assertEqual(response.headers['location'],new+'?source=email')
    def test_unknown_pages_and_api_are_not_rewritten(self):
        with TestClient(app) as client:
            self.assertEqual(client.get('/unknown.html').status_code,404)
            self.assertEqual(client.get('/api/v1/school/workspace').status_code,401)
            self.assertEqual(client.get('/school.js').status_code,200)

    def test_public_pages_load_their_own_app_assets(self):
        with TestClient(app) as client:
            for url, app_name, script in [
                ('/', 'inventory', 'app.js'),
                ('/school', 'school', 'school.js'),
                ('/parents', 'parents', 'parents.js'),
            ]:
                with self.subTest(app=app_name):
                    path = f'/apps/{app_name}/{script}'
                    self.assertIn(path, client.get(url).text)
                    self.assertEqual(client.get(path).status_code, 200)
                    legacy = client.get(f'/{script}?v=old', follow_redirects=False)
                    self.assertEqual(legacy.status_code, 308)
                    self.assertEqual(legacy.headers['location'], path + '?v=old')
                    self.assertEqual(client.get(f'/apps/{app_name}/index.html',
                                                follow_redirects=False).headers['location'], url)
