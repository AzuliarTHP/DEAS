"""Language now lives in Settings: switch it there, then return to the view under test."""


def dismiss_experience(page):
    """First start asks for the experience; choose advanced so setup suites see the classic workspace."""
    try:
        page.locator('.experience-welcome').wait_for(state='visible', timeout=5000)
        page.locator('.experience-welcome .experience-choice').nth(1).click()
        page.locator('.experience-welcome').wait_for(state='detached', timeout=5000)
    except Exception:
        pass


def set_locale(page, locale, back=None):
    dismiss_experience(page)
    page.locator('[data-node="settings"]').click()
    page.locator('#language-select').select_option(locale)
    if back:
        page.locator(back).click()
