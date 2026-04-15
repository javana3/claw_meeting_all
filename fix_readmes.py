import re

files = ['README.ja.md', 'README.ko.md', 'README.zh-CN.md', 'README.zh-TW.md']

style_block = """
    style [*] fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    style Collecting fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style FastPath fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style Scoring fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style Confirming fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style Committed fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style Failed fill:#eff6ff,stroke:#2563eb,color:#1e3a8a
    style Expired fill:#eff6ff,stroke:#2563eb,color:#1e3a8a"""

for filename in files:
    try:
        # Try different encodings
        for encoding in ['utf-8', 'utf-8-sig', 'cp949', 'euc-kr', 'latin-1']:
            try:
                with open(filename, 'r', encoding=encoding) as f:
                    content = f.read()
                print(f"Successfully read {filename} with {encoding}")
                break
            except UnicodeDecodeError:
                continue

        # Pattern: line ending with auto-cancel/auto-cancelled/自动取消 etc, then closing ```
        # We need to find stateDiagram blocks that are missing the style block
        # Look for patterns like "Expired --> [*]: ... auto-cancel" followed by "```"
        # and add the style block before ```

        # For stateDiagram - first occurrence (Plugin version)
        pattern1 = r'(Expired --> \[\*\]: [^\n]+\n)(\n```\n)(### [^\n]+)'
        if re.search(pattern1, content):
            content = re.sub(pattern1, r'\1' + style_block + r'\2\3', content)
            print(f"Fixed first stateDiagram in {filename}")
        else:
            print(f"First pattern not found in {filename}")

        with open(filename, 'w', encoding='utf-8') as f:
            f.write(content)
    except Exception as e:
        print(f"Error with {filename}: {e}")