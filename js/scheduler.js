// Compatibility shim: scheduled tasks are now implemented by js/dashboard/cron.js.
window.Scheduler={open(){if(window.ScheduledTasksWindow)new ScheduledTasksWindow();}};
