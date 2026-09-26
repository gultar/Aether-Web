from pathlib import Path


def write_file(
    filename: str,
    content: str,
    mode: str = "overwrite",
) -> str:
    """
    Write text to a file chosen by the LLM.

    The user must explicitly approve the write.

    mode:
        overwrite - create or replace the file
        append    - append to the existing file
    """

    if mode not in {"overwrite", "append"}:
        return f"Invalid write mode: {mode}"

    path = Path(filename).resolve()

    # -------------------------------------------------------------
    # Show exactly what the LLM is trying to do
    # -------------------------------------------------------------

    print("\n" + "=" * 60)
    print("[FILE WRITE PERMISSION]")
    print(f"File: {path}")
    print(f"Mode: {mode}")
    print(f"Content length: {len(content)} characters")

    if path.exists():
        print("WARNING: This file already exists.")

        if mode == "overwrite":
            print("WARNING: The existing file will be overwritten.")

        elif mode == "append":
            print("The new content will be appended to the file.")

    else:
        print("The file does not currently exist.")

    print("=" * 60)

    # -------------------------------------------------------------
    # Ask the user
    # -------------------------------------------------------------

    answer = input(
        "Allow this file write? [y/N]: "
    ).strip().lower()

    if answer not in {"y", "yes"}:
        return (
            f"File write denied by user: {path}"
        )

    # -------------------------------------------------------------
    # Create parent directories
    # -------------------------------------------------------------

    try:
        path.parent.mkdir(
            parents=True,
            exist_ok=True,
        )

    except Exception as error:
        return (
            f"Could not create directory "
            f"{path.parent}: "
            f"{type(error).__name__}: {error}"
        )

    # -------------------------------------------------------------
    # Write
    # -------------------------------------------------------------

    file_mode = (
        "a"
        if mode == "append"
        else "w"
    )

    try:
        with path.open(
            file_mode,
            encoding="utf-8",
        ) as file:
            file.write(content)

    except PermissionError:
        return (
            f"Permission denied while writing to: {path}. "
            f"You may need to run the program with higher privileges "
            f"if this is a protected location."
        )

    except Exception as error:
        return (
            f"Failed to write to {path}: "
            f"{type(error).__name__}: {error}"
        )

    return (
        f"Successfully wrote "
        f"{len(content)} characters to {path}."
    )