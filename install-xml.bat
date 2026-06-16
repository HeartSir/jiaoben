@echo off
schtasks /create /tn VenueBooking /xml "%~dp0VenueBooking.xml" /f
pause