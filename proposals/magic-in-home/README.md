# Reygent AI: Order Desk proposal for Magic in Home

Client-ready technical and commercial proposal (A4, 9 pages).

| File | Purpose |
| --- | --- |
| `Reygent-AI_Magic-in-Home_Order-Desk-Proposal.pdf` | The finished proposal |
| `build_proposal.py` | Generates the PDF using ReportLab and vector drawing only |
| `fonts/` | Inter and Source Serif 4 (SIL Open Font License, embedded in the PDF) |

## Rebuild

```sh
pip install reportlab
python3 proposals/magic-in-home/build_proposal.py
```

Commercial terms, the issue date, the reference number, the delivery window and the
validity period all live in the `CONFIG` block at the top of `build_proposal.py`. The
script checks that the workstream allocation adds up to ₹25,000. It also exits non-zero
if any content would cross into a page footer.

## Page structure

1. Cover
2. Executive summary and business opportunity
3. V1 features, functionality and permissions matrix
4. Operational workflow and the five-status model
5. Technology and integration qualifications
6. Dashboards, reporting and downloads
7. Itemized quotation (₹25,000 allocation)
8. Monthly subscription (₹19,999/month) and scope boundaries
9. Delivery plan, client inputs, next steps and acceptance
