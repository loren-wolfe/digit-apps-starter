/**
 * V2 label PDF fetch. Labels are purchased in the ShipStation UI, not by this Worker.
 */

import { AppErrorCode } from '@heysutton/sdk';

import { fetchLabelPdfBytes, getLabel } from './shipstation.js';

function pdfBase64FromInline(data) {
  const download = data?.label_download || data?.labelDownload || {};
  const href = download.href || download.pdf;
  if (typeof href === 'string' && href.startsWith('data:')) {
    const comma = href.indexOf(',');
    return comma >= 0 ? href.slice(comma + 1) : null;
  }
  return null;
}

function labelPdfUrl(data) {
  const download = data?.label_download || data?.labelDownload || {};
  const href = download.pdf || download.href;
  if (typeof href === 'string' && href.startsWith('https://')) return href;
  return null;
}

function stripPdfWhitespace(value) {
  return String(value || '').replace(/\s+/g, '');
}

export async function pdfBase64FromV2Label({ credentials, labelId }) {
  const fetched = await getLabel({
    credentials,
    labelId,
    downloadType: 'inline',
    format: 'pdf',
  });
  if (!fetched.ok) return fetched;
  const inline = pdfBase64FromInline(fetched.data);
  if (inline) {
    return { ok: true, data: { pdfBase64: stripPdfWhitespace(inline) } };
  }
  const url = labelPdfUrl(fetched.data);
  if (!url) {
    return {
      ok: false,
      code: AppErrorCode.UPSTREAM_ERROR,
      message: 'ShipStation did not return a downloadable PDF for this label.',
      status: 502,
    };
  }
  const bytes = await fetchLabelPdfBytes({ credentials, url });
  if (!bytes.ok) return bytes;
  return { ok: true, data: { pdfBase64: bytes.data.pdfBase64 } };
}
