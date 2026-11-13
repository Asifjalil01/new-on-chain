"""String and price formatters ensuring no scientific notation for tiny crypto prices."""

def format_price(price: float) -> str:
    """Formats price without scientific notation, handling micro-caps accurately."""
    if price is None:
        return "DATA UNAVAILABLE"
    if price == 0:
        return "$0.00"
    if price >= 1.0:
        return f"${price:,.2f}" if price >= 10.0 else f"${price:.4f}"
    
    # Tiny prices under $1.00
    formatted = f"{price:.12f}".rstrip("0")
    if formatted.endswith("."):
        formatted += "00"
    
    # Check if more than 4 leading zeros after decimal
    parts = formatted.split(".")
    if len(parts) == 2:
        decimals = parts[1]
        zero_count = len(decimals) - len(decimals.lstrip("0"))
        if zero_count >= 4:
            sig_figs = decimals[zero_count:zero_count + 4]
            return f"$0.0{{{zero_count}}}{sig_figs}"
    
    return f"${formatted}"
