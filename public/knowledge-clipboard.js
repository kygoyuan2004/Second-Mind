export function filesFromClipboard(clipboardData) {
  if (!clipboardData) return [];

  const directFiles = Array.from(clipboardData.files || []).filter(Boolean);
  if (directFiles.length) return directFiles;

  return Array.from(clipboardData.items || [])
    .filter((item) => item?.kind === 'file')
    .map((item) => item.getAsFile?.())
    .filter(Boolean);
}
