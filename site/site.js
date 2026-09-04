document.documentElement.classList.add('js');

const navigationToggle = document.querySelector('.nav-toggle');
const navigationLinks = document.querySelector('.nav-links');

if (navigationToggle && navigationLinks) {
  const screenReaderLabel = navigationToggle.querySelector('.sr-only');

  const setNavigationOpen = (open) => {
    navigationToggle.setAttribute('aria-expanded', String(open));
    navigationLinks.classList.toggle('is-open', open);
    if (screenReaderLabel) {
      screenReaderLabel.textContent = open
        ? navigationToggle.dataset.closeLabel
        : navigationToggle.dataset.openLabel;
    }
  };

  navigationToggle.addEventListener('click', () => {
    setNavigationOpen(navigationToggle.getAttribute('aria-expanded') !== 'true');
  });

  navigationLinks.addEventListener('click', (event) => {
    if (event.target.closest('a')) setNavigationOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && navigationToggle.getAttribute('aria-expanded') === 'true') {
      setNavigationOpen(false);
      navigationToggle.focus();
    }
  });
}

for (const tabGroup of document.querySelectorAll('[data-tabs]')) {
  const tabs = [...tabGroup.querySelectorAll('[role="tab"]')];
  const panels = [...tabGroup.querySelectorAll('[role="tabpanel"]')];

  const selectTab = (selectedTab, moveFocus = false) => {
    for (const tab of tabs) {
      const selected = tab === selectedTab;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      const panel = panels.find((candidate) => candidate.id === tab.getAttribute('aria-controls'));
      if (panel) panel.hidden = !selected;
    }
    if (moveFocus) selectedTab.focus();
  };

  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (event) => {
      let nextIndex;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = tabs.length - 1;
      if (nextIndex === undefined) return;
      event.preventDefault();
      selectTab(tabs[nextIndex], true);
    });
  }
}

const showMissingAssetNotice = (image) => {
  const figure = image.closest('.asset-figure');
  const notice = figure?.querySelector('.asset-pending');
  image.hidden = true;
  if (notice) notice.hidden = false;
  figure?.classList.add('asset-missing');
};

for (const image of document.querySelectorAll('.asset-figure img')) {
  image.addEventListener('error', () => showMissingAssetNotice(image), { once: true });
  if (image.complete && image.naturalWidth === 0) showMissingAssetNotice(image);
}
