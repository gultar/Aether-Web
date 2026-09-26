import subprocess


def run_powershell_command(cmd: str) -> str:
    """Run PowerShell without discarding useful output on non-zero exit codes.

    PowerShell commands can legitimately produce useful stdout while also writing
    warnings/errors to stderr (for example, recursive filesystem searches that
    encounter an inaccessible directory).  Return all three pieces of execution
    state to the agent instead of raising CalledProcessError.
    """
    result = subprocess.run(
        ["powershell", "-NoProfile", "-Command", cmd],
        shell=False,
        check=False,
        text=True,
        capture_output=True,
    )

    stdout = (result.stdout or "").strip()
    stderr = (result.stderr or "").strip()

    parts = [f"Return code: {result.returncode}"]
    parts.append(f"Stdout:\n{stdout}" if stdout else "Stdout: (empty)")
    parts.append(f"Stderr:\n{stderr}" if stderr else "Stderr: (empty)")
    return "\n\n".join(parts)
