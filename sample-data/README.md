# Sample data

Example spreadsheets in every shape the importer accepts, plus example orders. Upload any
of these from **Catalog → Upload sheets**. They describe the same imaginary store as
**Settings → Load demo store**.

| File | What it demonstrates |
|---|---|
| `sheet-a-master-item-list.xlsx` | Sheet A on its own, using the documented column names. |
| `sheet-a-master-item-list.csv` | The same thing as CSV — and, because the ID column is present, proof that re-uploading updates rather than duplicates. |
| `sheet-b-walking-order.xlsx` | Sheet B, option 1: aisles listed in walking order. |
| `combined-one-workbook.xlsx` | Both sheets as two tabs of one workbook. Upload this one file and both are detected. |
| `sheet-a-alternate-column-names.xlsx` | A different store's export — `SKU`, `Description`, `Manufacturer`, `Pack Size`, `Aisle #`, `Shelf Seq`, `UOM`, `Retail`. Detected without any manual mapping. |
| `sheet-b-option2-items-in-walking-order.xlsx` | Every item already in exact shelf order with a section column — upload it and the walk is set, with aisle headings. |
| `shelf-order-one-sheet-no-aisles.xlsx` | The simplest sheet that works: one column of product names in the order they sit on the shelf. Nothing else, and nothing to configure — the pick list comes out as one continuous walk. |
| `customers.xlsx` / `customers.csv` | A customer list — name, phone, email, delivery address and notes. Upload it from **Customers → Upload customer list**. |
| `example-orders.txt` | Three orders as they really arrive — phoned in, forwarded by email, and typed in a hurry with typos. Paste one into **New order**. |

## Replacing these with your own

The column names above are only defaults. Your own headers are matched against a long
list of synonyms, and anything unrecognised is a dropdown away in the import preview —
so in practice you can upload your real sheets unchanged.

The one column that matters most is `item_id`. With it, re-uploading a corrected sheet
updates your catalog in place. Without it the app generates a stable ID from
name + brand + size, which works too — but then renaming a product creates a new entry
instead of updating the old one.
