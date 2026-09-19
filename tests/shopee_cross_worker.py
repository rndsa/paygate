"""Real production JSONL server over BrowserTests' all-URLs-routed fixture.
Only fixture disables Chromium sandbox for root; production Worker stays unchanged.
Run via: node --disable-warning=ExperimentalWarning tests/shopee-cross.mjs
"""
import asyncio

from shopee_browser import BrowserTests, HTML


async def main():
    fixture = BrowserTests()
    try:
        await fixture.asyncSetUp()
        fixture.html = HTML.replace(
            "window.otp=verify.querySelector('input').value;",
            "window.otp=verify.querySelector('input').value; location.href='https://partner.shopee.co.id/';",
        )
        # Two captured rows make accidental first-store mapping detectable.
        fixture.stores['data']['list'].append({'storeId': 78, 'storeName': 'Synthetic second shop'})
        fixture.stores['data']['storeCount'] = 2
        # Actual start/verify/cancel parser + Worker + wire_result/emit, no response rewrite.
        await fixture.m.serve(fixture.worker)
        allowed = {fixture.m.LOGIN_URL, 'https://partner.shopee.co.id/',
                   fixture.m.PROFILE_URL, fixture.m.STORES_URL}
        assert set(fixture.requests) <= allowed
    finally:
        await fixture.asyncTearDown()


if __name__ == '__main__':
    asyncio.run(main())
