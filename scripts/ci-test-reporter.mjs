// CI fixtures contain only synthetic data. Make failures visible in Checks
// annotations as well as the access-controlled Actions log download.
const escape = (value) => String(value || '').replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
export default async function* report(source) {
  for await (const event of source) {
    if (event.type !== 'test:fail') continue;
    const data = event.data;
    const error = data.details?.error;
    const detail = [data.name, error?.message, error?.cause?.message, error?.cause?.stack || error?.stack]
      .filter(Boolean).join('\n').slice(0, 12_000);
    yield `::error title=Offline test failure::${escape(detail)}\n`;
  }
}
